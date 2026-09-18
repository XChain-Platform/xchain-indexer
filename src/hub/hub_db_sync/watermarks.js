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
 * XChain Indexer - Hub DB Sync Client: watermarks and liveness
 *
 * The stream watermark and the per-table height watermark on the consumer side,
 * the stall detector, the heartbeat watchdog, and the admission-era predicates
 * every barrier shares.
 *
 * Part of the hub-mirror client (src/hub/hub_db_sync.js), which installs the
 * methods here onto HubDbSync.prototype. Vendored byte-identical into
 * xchain-explorer by bin/sync-hub-mirror-client.sh: edit the xchain-indexer copy.
 *
 ********************************************************************/

const { getLogger } = require('../../observability/index.js');
// The mirror-admission family's consumer gate and its per-table margins. A FOURTH
// CLIENT_FILES entry alongside price_batching_floor_activation.js and, like it,
// dependency-free: the alternative threads an activation verdict through eleven predicate
// signatures, their waiters and every one of their call sites.
const { admitMarginBlocks, isMirrorAdmissionConsumerActive } = require('../../consensus/gates/mirror_admission_gate.js');
const { WATERMARK_STALL_CHECK_MS, watermarkStallVerdict, sanitizeHeights,
        heightsAdvanced } = require('./watermark_config.js');

module.exports = {

    // Advance the stream watermark (monotonic) and re-evaluate every pending
    // barrier waiter; a watermark advance can satisfy any of them.
    advanceWatermark(ts) {
        ts = Number(ts);
        if (!Number.isFinite(ts) || ts <= this.streamWatermark) return;
        this.streamWatermark = ts;
        // The watermark moved, so whatever the stall detector was timing is over: re-arm
        // from here and drop any latched stage-1 resync. Stamped on a real ADVANCE only,
        // never on a refused or repeated tip, because "the last time this mirror actually
        // certified progress" is the whole measurement.
        this._lastWatermarkAdvanceAt = Date.now();
        this._watermarkStallResyncAt = null;
        this.releasePriceWaiters();
        this.releasePriceTimeWaiters();
        this.releaseOracleWaiters();
        this.releaseMatchWaiters();
        this.releaseCallWaiters();
        this.releaseBridgeWaiters();
        this.releasePolicyWaiters();
        this.releaseAnchorAttestWaiters();
        this.releaseAttestResponseWaiters();
    },

    // The same re-evaluation, driven by a HEIGHT advance rather than a seconds advance.
    // Above the activation the height watermark is what satisfies every waiter above, and it
    // can move on a frame whose `ts` did not: without this a block released by a height
    // advance would still sit out the rest of its 60 s timeout on every single advance.
    releaseHeightWaiters() {
        this.releasePriceWaiters();
        this.releasePriceTimeWaiters();
        this.releaseOracleWaiters();
        this.releaseMatchWaiters();
        this.releaseCallWaiters();
        this.releaseBridgeWaiters();
        this.releasePolicyWaiters();
        this.releaseAnchorAttestWaiters();
        this.releaseAttestResponseWaiters();
    },

    // Record the newest tip the hub has claimed in a heartbeat, independently of whether
    // the watermark gate accepted it. A refused tip is exactly the evidence the stall
    // detector runs on, so it must be kept even when it changes nothing else.
    noteHubTip(ts) {
        const t = Number(ts);
        if (Number.isFinite(t) && t > this._hubTipTs) this._hubTipTs = t;
    },

    // Apply one heartbeat frame's two watermarks. Extracted from the socket handler so the
    // GATE is unit-drivable: both values are certifications about what this mirror holds, and
    // both are wrong until the REST bootstrap has drained the rows produced before the
    // subscription. A heights map installed early would certify exactly that gap, and a
    // barrier re-keyed onto it would open over it. Returns nothing; the caller has no decision
    // left to make.
    //
    // Every latch here is a refusal to certify coverage the mirror does not have: the
    // bootstrap has not drained, the hub is broadcasting a row shape we refuse to apply, or a
    // live apply FAILED. Without the last one the socket handler's catch would log the failure
    // and continue, and the very next heartbeat would advance both watermarks over a row that
    // was never written, opening the settlement barriers on it. The caller records the hub's
    // claimed tip BEFORE this gate, because a tip the gate refuses is exactly the evidence the
    // stall detector runs on.
    handleWatermarkFrame(event) {
        if (!this._bootstrapDrained || this._schemaMismatchSeen || this._applyFailureSeen) return;
        // Heights first, so waiters released by the seconds advance below already see the
        // fresh map rather than the previous frame's.
        this.noteHeights((event || {}).heights);
        this.advanceWatermark((event || {}).ts);
    },

    // ── The height watermark: consumer side ────────────────────────────────────
    //
    // Install the `heights` object off whichever carrier delivered it (the watermark
    // heartbeat, the ready frame, or a REST snapshot page). Returns true when any entry
    // actually advanced, which is what the stall detector measures its window from.
    //
    // A carrier with no usable object CLEARS the map rather than leaving the previous one
    // standing. That is the whole fail-closed rule in one line: an older hub, or one that has
    // stopped publishing, must make this node defer, not coast on a claim nobody is renewing.
    noteHeights(raw) {
        const next = sanitizeHeights(raw);
        if (next === null) {
            this.heightWatermarks = {};
            return false;
        }
        const advanced = heightsAdvanced(this.heightWatermarks, next);
        this.heightWatermarks = next;
        // Stamp the first install too: until one lands, the height axis is a COLD START and
        // the stall detector must stay quiet on it, exactly as a null lastAdvanceAt does on
        // the seconds axis.
        if (advanced || this._heightsLastAdvanceAt == null) this._heightsLastAdvanceAt = Date.now();
        this.reconcileHeightShortfalls();
        if (advanced) this.releaseHeightWaiters();
        return advanced;
    },

    // This indexer's own chain code, normalised the way the hub keys the map. Null when the
    // mirror was built without a coin, which reads as no admission evidence at all.
    admissionChain() {
        if (this.coin === null || this.coin === undefined) return null;
        const c = String(this.coin).trim().toUpperCase();
        return c === '' ? null : c;
    },

    // Whether the CONSUMER side of the admission flag day is armed for this chain at block B.
    // Inert (which is every network in this train) means every predicate below reduces to the
    // clock form it has today, byte for byte.
    admissionActiveAt(blockHeight) {
        if (blockHeight === null || blockHeight === undefined) return false;
        return isMirrorAdmissionConsumerActive(this.coin, this.network, blockHeight);
    },

    // The published height for one (table, chain), or null when there is no usable entry.
    // Null is never coerced to zero anywhere in this file: a zero would certify a genesis-era
    // mirror as complete for every block, which is the fail-OPEN this design may not have.
    publishedHeight(table, chain) {
        const entry = this.heightWatermarks[table];
        if (!entry || typeof entry !== 'object') return null;
        const h = entry[chain];
        return (typeof h === 'number' && Number.isSafeInteger(h) && h >= 0) ? h : null;
    },

    // The family's barrier comparison, identical for every member: heights[table][C] >= B -
    // ADMIT_MARGIN_BLOCKS[table]. Nothing here reads t(B), which is the point of the whole
    // design: heights do not move with a miner's stamp, so a block stamped 7200 s ahead is
    // height B like any other.
    //
    // A shortfall is RECORDED rather than merely returned, because the mirror's own stall
    // detector has no other way to see a heights map that froze while `ts` kept ticking.
    heightSatisfied(table, blockHeight) {
        const chain = this.admissionChain();
        const b = Number(blockHeight);
        if (chain === null || !Number.isFinite(b)) return false;
        const target = b - admitMarginBlocks(table);
        const key = table + '|' + chain;
        const h = this.publishedHeight(table, chain);
        if (h === null || h < target) {
            if (!(this._heightShortfalls[key] >= target)) this._heightShortfalls[key] = target;
            return false;
        }
        delete this._heightShortfalls[key];
        return true;
    },

    // Drop every shortfall the newly installed map has caught up with, so a mirror that
    // recovers stops being reported as stalled without waiting for another block to ask.
    reconcileHeightShortfalls() {
        for (const key of Object.keys(this._heightShortfalls)) {
            const split = key.lastIndexOf('|');
            const h = this.publishedHeight(key.slice(0, split), key.slice(split + 1));
            if (h !== null && h >= this._heightShortfalls[key]) delete this._heightShortfalls[key];
        }
    },

    // True while at least one height comparison this node actually made is still short.
    heightsShort() {
        return Object.keys(this._heightShortfalls).length > 0;
    },

    // The height clause appended to a timed-out barrier's message ABOVE the activation. The
    // message's existing prefix is untouched: two unit tests and the api-status smoke match on
    // it, and an operator greps for it.
    heightTail(table, blockHeight) {
        const chain = this.admissionChain();
        const h = (chain === null) ? null : this.publishedHeight(table, chain);
        return ' (admission height ' + table + '.' + (chain === null ? 'unknown' : chain) +
               ' at ' + (h === null ? 'none' : h) +
               ', needs ' + (Number(blockHeight) - admitMarginBlocks(table)) + ')';
    },

    // Sample the stall condition once and act on the verdict. Split from the timer so a
    // test can drive a single evaluation at a chosen clock, with no socket and no DB.
    checkWatermarkStall(now) {
        if (now === undefined) now = Date.now();
        if (!this.enabled || !this.running) return 'ok';

        const verdict = watermarkStallVerdict({
            stallMs:         this.watermarkStallMs,
            exitMs:          this.watermarkStallExitMs,
            pollMode:        !!this._pollMode,
            schemaMismatch:  !!this._schemaMismatchSeen,
            lastAdvanceAt:   this._lastWatermarkAdvanceAt,
            resyncAt:        this._watermarkStallResyncAt,
            hubTipTs:        this._hubTipTs,
            streamWatermark: this.streamWatermark,
            // The height dimension (C20): a `heights` map that froze while `ts` kept ticking
            // holds every re-keyed barrier and is invisible to the comparison above.
            heightsLastAdvanceAt: this._heightsLastAdvanceAt,
            heightsShort:         this.heightsShort()
        }, now);
        if (verdict === 'ok') return verdict;

        const frozenFrom = (this._lastWatermarkAdvanceAt == null)
            ? this._heightsLastAdvanceAt : this._lastWatermarkAdvanceAt;
        const frozenS = Math.round((now - frozenFrom) / 1000);
        const shape   = 'stream watermark frozen at ' + this.streamWatermark + ' for ' + frozenS +
                        's while the hub heartbeat tip reached ' + this._hubTipTs +
                        (this.heightsShort()
                            ? '; height watermark short at ' + JSON.stringify(this._heightShortfalls)
                            : '');

        if (verdict === 'resync') {
            this._watermarkStallResyncAt = now;
            getLogger().error('HubDbSync: ' + shape + '. Heartbeats are arriving, so the transport is ' +
                'healthy and the mirror is certifying nothing; forcing a subscribe-then-bootstrap ' +
                'cycle, then exiting if it is still frozen ' +
                Math.round(this.watermarkStallExitMs / 1000) + 's from now.');
            // Deliberately bypasses requestResync's hold-ceiling throttle: this detector
            // carries its own one-per-episode latch above, and a block-loop resync minutes
            // earlier must not silently consume the single remedy stage 2 is timing.
            this.driveResync(shape);
            return verdict;
        }

        // Stage 2. Re-arm the latch first so a consumer whose handler does NOT end the
        // process keeps re-driving on the same cadence instead of re-firing every sample.
        this._watermarkStallResyncAt = now;
        const reason = 'hub-mirror stream watermark stalled: ' + shape + ', still frozen ' +
                       Math.round(this.watermarkStallExitMs / 1000) + 's after a forced resync ' +
                       '(HUB_SYNC_WATERMARK_STALL_S / HUB_SYNC_WATERMARK_STALL_EXIT_S)';
        getLogger().error('HubDbSync: ' + reason);
        this.driveResync(shape + ' after a forced resync');
        if (this._onFatalStall) this._onFatalStall(reason);
        else getLogger().error('HubDbSync: no onFatalStall handler wired, so this mirror stays up and ' +
            'keeps re-driving; a consumer that wants a supervisor restart must wire one.');
        return verdict;
    },

    // Cadence for the sampler, clamped down when the windows themselves are small so a
    // short test or a short operator override is still sampled several times per window.
    stallCheckIntervalMs() {
        const windows = [this.watermarkStallMs, this.watermarkStallExitMs].filter((v) => v > 0);
        const smallest = windows.length ? Math.min.apply(null, windows) : WATERMARK_STALL_CHECK_MS;
        return Math.max(1000, Math.min(WATERMARK_STALL_CHECK_MS, Math.floor(smallest / 4)));
    },

    startStallDetector() {
        this.stopStallDetector();
        if (!(this.watermarkStallMs > 0)) return;
        this._stallTimer = setInterval(() => {
            // A throw here would kill the interval and silently retire the last bound this
            // mirror has, so the sampler swallows and keeps its cadence.
            try { this.checkWatermarkStall(); }
            catch (err) { getLogger().warn('HubDbSync: watermark stall check failed: ' + (err && err.message)); }
        }, this.stallCheckIntervalMs());
        if (typeof this._stallTimer.unref === 'function') this._stallTimer.unref();
    },

    stopStallDetector() {
        if (this._stallTimer) {
            clearInterval(this._stallTimer);
            this._stallTimer = null;
        }
    },

    // Adopt the hub's advertised heartbeat cadence (from the 'ready' message's
    // watermark_interval_ms) so the watchdog timeout self-sizes to 3x the hub's
    // ACTUAL interval instead of a locally-guessed env default. Backward compatible:
    // an older hub omits the field (value undefined/NaN) and this leaves the
    // env-seeded interval/timeout untouched. Returns true when a new interval was
    // adopted so the caller can re-arm the running watchdog at the new cadence.
    adoptHubWatermarkInterval(watermarkIntervalMs) {
        let ms = Number(watermarkIntervalMs);
        if (!Number.isFinite(ms) || ms <= 0) return false;
        // Clamp both ends: the value arrives from the hub over the wire, so an
        // arbitrarily small interval would drive this client's watchdog timer
        // into a busy loop, and an arbitrarily large one would disable the
        // stall detection the watchdog exists to provide. The bounds sit far
        // outside any real heartbeat cadence, so a legitimate hub is never
        // clamped.
        const MIN_WATERMARK_INTERVAL_MS = 1000;
        const MAX_WATERMARK_INTERVAL_MS = 300000;
        ms = Math.min(Math.max(ms, MIN_WATERMARK_INTERVAL_MS), MAX_WATERMARK_INTERVAL_MS);
        this.watermarkIntervalMs = ms;
        this.watermarkTimeoutMs = ms * 3;
        return true;
    },

    // Start the heartbeat-timeout watchdog for the given live socket. Called once
    // the socket is open; cleared in the 'close'/'error' cleanup so it can never
    // fire against a dead socket object or leak a timer across reconnects.
    startWatchdog(ws) {
        this._lastHeartbeatAt = Date.now();
        this.stopWatchdog();
        this._watchdogTimer = setInterval(() => {
            if (this._lastHeartbeatAt == null) return;
            const idleMs = Date.now() - this._lastHeartbeatAt;
            if (idleMs >= this.watermarkTimeoutMs) {
                getLogger().warn('HubDbSync: no watermark heartbeat for ' + idleMs +
                    'ms (timeout ' + this.watermarkTimeoutMs + 'ms); terminating stalled socket');
                ws.terminate();
            }
        }, this.watermarkIntervalMs);
        if (typeof this._watchdogTimer.unref === 'function') this._watchdogTimer.unref();
    },

    // Clear the watchdog timer. Safe to call whether or not one is running.
    stopWatchdog() {
        if (this._watchdogTimer) {
            clearInterval(this._watchdogTimer);
            this._watchdogTimer = null;
        }
    },

};
