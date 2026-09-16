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
 * XChain Indexer - Health response: process counters
 *
 * The per-action-type counters and the reorg counters of the `health`
 * payload. Both are process-local observability, never on a consensus-hashed
 * path; buildHealthResponse (src/api/health.js) places each at the position it
 * always held, so the payload keeps its key order.
 *
 ********************************************************************/

// Per-type accepted/rejected counts since the process started. Null when the
// actions instance is not yet initialised (e.g. very early in boot or in unit
// tests that stub the indexer). Never on any consensus-hashed path.
function actionCounters(indexer){
    return (indexer.actions && typeof indexer.actions.getActionCounters === 'function')
                ? indexer.actions.getActionCounters()
                : null;
}

// Reorg/rollback observability: total processed reorgs and the block index +
// epoch-ms timestamp of the most recent one, so the dashboard can meter the
// decoder->indexer reorg handshake instead of a frequently-reorging chain
// presenting as an ordinary healthy indexer. Null when the API server did not
// (or could not) read them.
function reorgFields(reorgStats){
    return {
        reorgsProcessed:  reorgStats ? reorgStats.reorgsProcessed : null,
        lastReorgBlock:   reorgStats ? reorgStats.lastReorgBlock  : null,
        lastReorgAt:      reorgStats ? reorgStats.lastReorgAt     : null
    };
}

module.exports = { actionCounters, reorgFields };
