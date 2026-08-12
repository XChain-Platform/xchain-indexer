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
 **********************************************************************/

/*
 * Service-specific Prometheus metrics for xchain-indexer.
 *
 * Lives outside src/observability/ on purpose: that directory is vendored
 * byte-identically from xchain-hub and bin/check-observability-parity.js fails
 * on any drift, so a per-service metric may only use the shared module's public
 * API from the service's own code. It is its own module rather than inline in
 * api.js because api.js self-starts on require (it calls startApi() at load and
 * exits on missing env), so nothing in it is reachable from a unit test.
 */

'use strict';

/**
 * Register the indexer's poll-freshness heartbeat on an installed registry.
 *
 * Commit recency is exposed today only through the /status JSON, so a wedged
 * block poller leaves no trace on the metrics scrape and is undetectable if
 * /status polling itself regresses. This gauge makes
 * `time() - xchain_indexer_last_block_committed_timestamp_seconds` an
 * independent stall signal.
 *
 * @param {{registry: ?object}} observability  installObservability() handle; registry is
 *                                            null unless METRICS_ENABLED, and a null
 *                                            registry registers nothing.
 * @param {{lastBlockCommittedAt: ?number}} indexer  live indexer, read at scrape time.
 * @returns {boolean} true when the metric was registered.
 */
function installIndexerMetrics(observability, indexer){
    const registry = observability && observability.registry;
    if(!registry || !indexer) return false;

    const lastCommitTs = registry.gauge({
        name: 'xchain_indexer_last_block_committed_timestamp_seconds',
        help: 'Unix time of the most recent committed block; stops advancing when the block poll stalls'
    });

    // Read at scrape time so the value tracks the live indexer without threading
    // a metrics write through the commit path. Leave the series ABSENT until the
    // first commit: an indexer that has never committed is starting up, not
    // stalled, and a zero would render as a 1970 timestamp and page instantly.
    registry.addCollector(() => {
        if(indexer.lastBlockCommittedAt) lastCommitTs.set({}, indexer.lastBlockCommittedAt / 1000);
    });

    return true;
}

module.exports = { installIndexerMetrics };
