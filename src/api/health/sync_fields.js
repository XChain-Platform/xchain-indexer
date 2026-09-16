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
 * XChain Indexer - Health response: serving state and sync position
 *
 * The verdict, the committed position and the database circuit-breaker states
 * of the `health` payload (status through indexerDbCircuit).
 * buildHealthResponse (src/api/health.js) spreads the returned object at the
 * position these fields always held, so the payload keeps its key order.
 *
 ********************************************************************/

// Is this process serving, how far has it committed, and what do the two
// database circuit breakers say. An open breaker on either database makes the
// verdict unhealthy: a syncing-looking indexer stalled behind a tripped
// breaker is the case this endpoint exists to tell apart. The heights are the
// values the API server already resolved, passed in.
function syncFields(indexer, { indexerRunning, lastIndexedBlock, inFlightBlock }){
    let decoderDbCircuit = indexer.decoderDb ? indexer.decoderDb.circuitState : null;
    let indexerDbCircuit = indexer.indexerDb ? indexer.indexerDb.circuitState : null;
    let circuitOpen = decoderDbCircuit === 'open' || indexerDbCircuit === 'open';

    return {
        status:           (indexerRunning && !circuitOpen) ? "healthy" : "unhealthy",
        running:          indexerRunning,
        synced:           indexer.isSynced(),
        // COMMITTED height only: read through apiView(), the same
        // committed-only pooled connection every federation query guard uses, so
        // a client may poll health and immediately query AT this height. The
        // block being parsed right now is reported separately as inFlightBlock;
        // it is not indexed yet and a reorg may mean it never is.
        lastIndexedBlock: lastIndexedBlock,
        inFlightBlock:    (inFlightBlock === undefined) ? null : inFlightBlock,
        decoderBlock:     indexer.lastDecoderBlock,
        lag:              (indexer.lastDecoderBlock != null && lastIndexedBlock != null)
                            ? indexer.lastDecoderBlock - lastIndexedBlock
                            : null,
        decoderDbCircuit: decoderDbCircuit,
        indexerDbCircuit: indexerDbCircuit
    };
}

module.exports = { syncFields };
