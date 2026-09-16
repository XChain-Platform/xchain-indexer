/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Indexer - Hub config poll
 *
 * The live hub config poll: the cadence reader, the staleness boundary derived from
 * that same reader (with the age computation health.js and api.js share), and the
 * unref'd poll timer that re-applies the overlay when the hub's committed sequence
 * advances. The timer is installed onto XChainIndexer.prototype by ../XChainIndexer.js,
 * which also re-exports the default and the three functions.
 *
 ********************************************************************/

const { readEnvNow } = require('../config.js');
const { getLogger } = require('../observability/index.js');

// Hub->indexer config poll cadence (ms). This is the sole staleness / propagation bound for the
// live-polled governance overlay: nothing else refreshes it, so an overlay older than a small
// multiple of this interval means the hub is unreachable. Overridable via
// HUB_CONFIG_POLL_INTERVAL_MS. Purely operational/observability, NOT a consensus parameter.
const DEFAULT_HUB_CONFIG_POLL_INTERVAL_MS = 60000;
// Return the cadence actually in force. One reader feeds both the poll timer and the staleness
// boundary below, so the two interval contracts cannot disagree: deriving the boundary from the
// DEFAULT while the timer honoured the override made a 10s poll report fresh until 180s instead
// of 30s, and a 10-minute poll report stale after three minutes. The read stays at
// CALL time and is deliberately not hoisted to module load, nor folded into config.js's
// load-time CONFIG_ENV snapshot: any consumer that requires this module before running its own
// dotenv.config() would then miss HUB_CONFIG_POLL_INTERVAL_MS from the documented `.env` and
// silently revert the knob to the 60s default. So it goes through readEnvNow, the config home's
// call-time accessor, which keeps the environment read inside config.js without snapshotting it.
function effectiveHubConfigPollIntervalMs(){
    return parseInt(readEnvNow('HUB_CONFIG_POLL_INTERVAL_MS'), 10) || DEFAULT_HUB_CONFIG_POLL_INTERVAL_MS;
}
// An overlay older than this is reported `stale`. Three poll intervals tolerates a couple of
// missed/slow polls before flagging: a purely operational outage-observability margin.
// This is independent of the WS_WATERMARK_GRACE constants (600s price/oracle, 120s match),
// which gate consensus-critical block-processing barriers; the two serve different concerns
// and their values need not (and do not) match.
function hubConfigStalenessLimitMs(){
    return effectiveHubConfigPollIntervalMs() * 3;
}

// Shared age/staleness computation for the hub-config overlay, used by both health.js and api.js
// so the age math and the staleness threshold live in exactly one place. `now` and
// `lastHubConfigFetchAt` are epoch-ms. Returns { ageSeconds:(number|null), stale:boolean }.
function hubConfigStaleness(lastHubConfigFetchAt, now){
    if(lastHubConfigFetchAt == null) return { ageSeconds: null, stale: false };
    let ageMs = now - lastHubConfigFetchAt;
    return { ageSeconds: Math.floor(ageMs / 1000), stale: ageMs > hubConfigStalenessLimitMs() };
}

const hubConfigPollMethods = {

    // Poll the hub for PBFT-committed config changes. The startup overlay runs only
    // once; without this loop a governance-committed change to a tunable/display param
    // (i.e. one safe to live-poll; see the consensus exclusion list in mergeHubParams)
    // would not take effect until the indexer process is restarted. We
    // re-apply the overlay only when the hub's committed sequence advances past the
    // last one we applied, so a steady-state poll is a cheap no-op. Against an older
    // hub that returns the bare map, seq stays 0 and the overlay is never re-applied
    // (matching pre-existing startup-only behavior). The timer is unref'd so it never
    // keeps the process alive. Interval is HUB_CONFIG_POLL_INTERVAL_MS (default 60s).
    startHubConfigPolling(){
        if(!this.hubClient || !this.hubClient.configEnabled) return;
        if(this._hubConfigPollTimer) return;
        // Same reader the staleness boundary is derived from, so the reported boundary is
        // always three of THESE intervals.
        const intervalMs = effectiveHubConfigPollIntervalMs();
        // Guarded against self-overlap like startStateTreeMetric (./background_jobs.js): a
        // getallconfigs call outrunning the interval (restarting/partitioned hub)
        // must not stack overlapping in-flight polls.
        this._hubConfigPollRunning = false;
        this._hubConfigPollTimer = setInterval(async () => {
            if(this._hubConfigPollRunning) return;   // a prior slow poll is still in flight
            this._hubConfigPollRunning = true;
            try {
                await this.pollHubConfigOnce();
            } catch(err) {
                getLogger().warn('XChainIndexer: hub config poll failed, keeping current config:', err.message || err);
            } finally {
                this._hubConfigPollRunning = false;
            }
        }, intervalMs);
        if(this._hubConfigPollTimer.unref) this._hubConfigPollTimer.unref();
    }
};

module.exports = { DEFAULT_HUB_CONFIG_POLL_INTERVAL_MS, effectiveHubConfigPollIntervalMs, hubConfigStalenessLimitMs,
                   hubConfigStaleness, hubConfigPollMethods };
