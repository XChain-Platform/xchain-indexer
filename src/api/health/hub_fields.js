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
 * XChain Indexer - Health response: hub link fields
 *
 * The hub config overlay age and the hub push retry queue counts of the
 * `health` payload (lastHubConfigFetchAt through hub_push_queue).
 * buildHealthResponse (src/api/health.js) awaits this BEFORE it assembles the
 * payload, as it always did, and spreads the result at the position these
 * fields always held, so the payload keeps its key order.
 *
 ********************************************************************/

const { hubConfigStaleness } = require('../../XChainIndexer');

// How stale the hub config overlay is and how much the hub push queue holds.
// Async only for the queue's stats read.
async function hubFields(indexer, now){
    // How long ago the indexer last got a response from the hub for its config
    // overlay. null until the first success. When the hub is down this age keeps
    // climbing while status stays "healthy", so an operator can spot that the
    // hub config overlay is stale. (Consensus params like activation delay,
    // expiration fee, and staking thresholds are NOT live-polled; they come from
    // the per-chain local config. This age reflects only tunable/display params
    // the overlay is permitted to apply.)
    let lastHubConfigFetchAt = indexer.lastHubConfigFetchAt || null;
    // Age + explicit staleness (past hubConfigStalenessLimitMs() = 3 poll intervals), computed
    // by the one shared helper so health and the /health api agree on the threshold.
    let hubConfig            = hubConfigStaleness(lastHubConfigFetchAt, now);
    let hubConfigAgeSeconds  = hubConfig.ageSeconds;
    let hubConfigStale       = hubConfig.stale;

    // Pending and permanently-failed counts from the hub push retry queue.
    // null when no hub is configured. A non-zero `failed` count means price/oracle
    // rows exhausted all retries and were silently dropped; an operator should
    // check hub connectivity and clear the backlog.
    let hubPushQueue = null;
    if(indexer.hubPushQueue){
        try {
            hubPushQueue = await indexer.hubPushQueue.getStats();
        } catch (e){
            // DB unreachable; leave null rather than crashing the health response.
        }
    }

    return {
        lastHubConfigFetchAt: lastHubConfigFetchAt,
        hubConfigAgeSeconds:  hubConfigAgeSeconds,
        hubConfigStale:       hubConfigStale,
        hub_push_queue:   hubPushQueue
    };
}

module.exports = { hubFields };
