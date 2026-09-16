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
 * XChain Indexer - JSON-RPC price batch family: which oracle rounds already ride a valid PRICE batch.
 *
 * Each group factory below closes over the context object src/api.js builds
 * (apiContext) and returns its methods verbatim; src/api/rpc/index.js merges
 * every family into the one controller the JSON-RPC router dispatches on.
 *
 ********************************************************************/

const priceBatchQuery = require('../price_batch_query');
const { getLogger } = require('../../observability/index.js');

// Which oracle rounds in [first_round, last_round] already ride a VALID PRICE
// batch on this chain. The hub's batch publisher asks before it re-proposes a
// buffered window: a validator's own tables cannot answer (its snapshots keep
// the per-round proof for rounds it finalized itself, and its published-round
// markers cover only what IT broadcast), so without this read a hub restarted
// onto a full buffer re-publishes windows the chain already carries, at a fee
// apiece. Invalid wires are deliberately excluded: they do not carry their
// rounds for a replaying node, so those windows are right to fill. Returns the
// latest indexed block in the same round-trip, and `truncated` when the page
// filled, so the caller pages past its last batch rather than reading the
// remainder as empty. Body: { first_round, last_round, limit? }
function priceBatchesRpc({ indexer }){
    return {
        async getpricebatches({first_round, last_round, limit}){
            if(!indexer.indexerDb)
                return { error: 'indexer database not ready' };
            let v = priceBatchQuery.validatePriceBatchParams({ first_round, last_round, limit });
            if(!v.ok) return { error: v.error };
            // Federation READ isolation: committed-only, off the block tx.
            let db = indexer.indexerDb.apiView();
            try {
                let latest = await db.getLatestBlockIndex();
                let rows   = await db.getPriceBatchesOverlappingRange(
                    'valid', v.last_round, v.first_round, v.limit);
                return priceBatchQuery.buildPriceBatchesResponse(latest, rows, v);
            } catch (err) {
                getLogger().error('getpricebatches error:', err);
                return { error: 'failed to look up price batches' };
            }
        },
    };
}

module.exports = { buildPriceBatchesRpc: priceBatchesRpc };
