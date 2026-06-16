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
 * XChain Indexer - Health response assembly
 *
 * Pure (no I/O) builder for the `health` JSON-RPC payload. Lives apart from
 * api.js so it can be unit-tested without booting the Express server or
 * requiring database env vars. api.js does the one async DB lookup
 * (lastIndexedBlock) and the clock read, then hands the resolved values here.
 *
 ********************************************************************/

// Assemble the health() response from an indexer instance plus the few
// values the API server owns (whether start() is still running, the last
// fatal error, the freshly-read indexed-block height, and the current epoch
// ms). Kept side-effect-free so a test can drive every state by passing a
// plain stub indexer.
function buildHealthResponse({ indexer, indexerRunning, indexerError, lastIndexedBlock, now }){
    let decoderDbCircuit = indexer.decoderDb ? indexer.decoderDb.circuitState : null;
    let indexerDbCircuit = indexer.indexerDb ? indexer.indexerDb.circuitState : null;
    let circuitOpen = decoderDbCircuit === 'open' || indexerDbCircuit === 'open';

    // How long ago the indexer last got a response from the hub for its config
    // overlay. null until the first success. When the hub is down this age keeps
    // climbing while status stays "healthy", so an operator can spot that the
    // hub config overlay is stale. (Consensus params — activation delay, expiration
    // fee, staking — are NOT live-polled; they come from the per-chain local config.
    // This age reflects only tunable/display params the overlay is permitted to apply.)
    let lastHubConfigFetchAt = indexer.lastHubConfigFetchAt || null;
    let hubConfigAgeSeconds  = (lastHubConfigFetchAt != null)
                                ? Math.floor((now - lastHubConfigFetchAt) / 1000)
                                : null;

    return {
        status:           (indexerRunning && !circuitOpen) ? "healthy" : "unhealthy",
        running:          indexerRunning,
        synced:           indexer.isSynced(),
        lastIndexedBlock: lastIndexedBlock,
        decoderBlock:     indexer.lastDecoderBlock,
        lag:              (indexer.lastDecoderBlock != null && lastIndexedBlock != null)
                            ? indexer.lastDecoderBlock - lastIndexedBlock
                            : null,
        decoderDbCircuit: decoderDbCircuit,
        indexerDbCircuit: indexerDbCircuit,
        // Why the block counter is not advancing, or null when advancing
        // normally: a hub-sync barrier timeout (price/oracle/match/call/snapshot)
        // or a VM executor host fault. Lets an operator tell these stalls apart
        // from a tripped DB circuit breaker (decoderDbCircuit/indexerDbCircuit
        // === 'open') and a healthy catch-up, all of which otherwise present
        // identically as a growing lag.
        stallReason:      indexer.stallReason || null,
        lastHubConfigFetchAt: lastHubConfigFetchAt,
        hubConfigAgeSeconds:  hubConfigAgeSeconds,
        error:            indexerError ? indexerError.message : null
    };
}

module.exports = { buildHealthResponse };
