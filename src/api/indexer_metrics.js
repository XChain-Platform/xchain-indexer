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
 * byte-identically from xchain-hub and the vendored-copy parity check fails
 * on any drift, so a per-service metric may only use the shared module's public
 * API from the service's own code. It is its own module rather than inline in
 * api.js because api.js self-starts on require (it calls startApi() at load and
 * exits on missing env), so nothing in it is reachable from a unit test.
 */

'use strict';

/**
 * Register the indexer's poll-freshness heartbeat and reorg metrics on an installed registry.
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
 * @param {{lastBlockCommittedAt: ?number, lastPollAt: number, reorgsProcessedSinceStart: number,
 *          stallReason: ?string}} indexer  live indexer, read at scrape time.
 * @returns {boolean} true when the metrics were registered.
 */
function installIndexerMetrics(observability, indexer){
    const registry = observability && observability.registry;
    if(!registry || !indexer) return false;

    const lastCommitTs = registry.gauge({
        name: 'xchain_indexer_last_block_committed_timestamp_seconds',
        help: 'Unix time of the most recent committed block; stops advancing when the block poll stalls'
    });

    // Commit recency alone cannot discriminate a wedged poller from a quiet chain: a
    // caught-up indexer commits nothing for hours while perfectly healthy, so the gauge
    // above is old in the healthy case too. The iteration heartbeat is the discriminator,
    // and it is the ONLY signal that sees a loop hung inside an await.
    const lastPollTs = registry.gauge({
        name: 'xchain_indexer_last_poll_timestamp_seconds',
        help: 'Unix time of the most recent block-poll loop iteration; stops advancing when the loop stops iterating'
    });

    // Read at scrape time so the value tracks the live indexer without threading
    // a metrics write through the commit path. Leave the series ABSENT until the
    // first commit: an indexer that has never committed is starting up, not
    // stalled, and a zero would render as a 1970 timestamp and page instantly.
    // Same rule for the heartbeat, whose 0 means the loop has not iterated yet.
    registry.addCollector(() => {
        if(indexer.lastBlockCommittedAt) lastCommitTs.set({}, indexer.lastBlockCommittedAt / 1000);
        if(indexer.lastPollAt) lastPollTs.set({}, indexer.lastPollAt / 1000);
    });

    registerReorgMetrics(registry, indexer);
    return true;
}

// Register the indexer half of the reorg handshake, which only the health payload carried.
// The decoder exports its reorg counter; without these a Prometheus-only deployment sees
// decoder reorgs and nothing from the stage that unwinds the ledger.
function registerReorgMetrics(registry, indexer){
    const reorgsProcessed = registry.counter({
        name: 'xchain_indexer_reorgs_processed_total',
        help: 'Decoder reorg events (one per orphaned block, not one per reorg) this indexer process has recorded as processed since it started'
    });
    const rollbackInProgress = registry.gauge({
        name: 'xchain_indexer_rollback_in_progress',
        help: '1 while a reorg rollback is unwinding the ledger; stays 1 through a hung or retrying rollback'
    });

    // Render both from the first scrape: 0 is a real reading for each, unlike a timestamp.
    registry.addCollector(() => {
        const processed = Number(indexer.reorgsProcessedSinceStart);
        reorgsProcessed.setMonotonic({}, Number.isFinite(processed) ? processed : 0);
        rollbackInProgress.set({}, indexer.stallReason === 'reorg_rollback' ? 1 : 0);
    });
}

module.exports = { installIndexerMetrics };
