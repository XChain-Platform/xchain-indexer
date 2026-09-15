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
 * XChain Indexer - JSON-RPC reorg history family: orphaned block hashes from the decoder's REORG events.
 *
 * Each group factory below closes over the context object src/api.js builds
 * (apiContext) and returns its methods verbatim; src/api/rpc/index.js merges
 * every family into the one controller the JSON-RPC router dispatches on.
 *
 ********************************************************************/

const reorgHistoryQuery = require('../reorg_history_query');
const { getLogger } = require('../../observability/index.js');

// Reorg history WITH the orphaned block hashes, from the decoder's `events`
// table (code='REORG', data = [{block_index, block_hash}]).
//
// Serves xchain-hub's ReorgHandler: the handler
// can confirm the announced NEW hash is what its own node serves at the reorg
// height, but nothing today proves the announced OLD hash was ever canonical
// there, so one Byzantine validator can drive a fake-reorg rollback with a
// fabricated oldHash. db.js's getReorgsSince() keeps only the deepest
// block_index and drops the hashes, so this is a separate read.
//
// Pass block_index + block_hash to ask the precise question: "did you orphan
// THIS hash at THIS height?" -> `matched` is the answer. Both must occur on the
// SAME orphaned block. Reads the DECODER db (events is a decoder table).
function reorgHistoryRpc({ indexer }){
    return {
        async getreorghistory({since_id, block_index, block_hash, limit}){
            if(!indexer.decoderDb)
                return { error: 'decoder database not ready' };
            let v = reorgHistoryQuery.validateReorgHistoryParams({ since_id, block_index, block_hash, limit });
            if(!v.ok) return { error: v.error };
            // Federation READ isolation: route through apiView for symmetry
            // with the indexerDb federation reads. The decoder DB never opens a block
            // transaction (its doQuery already pools), so this is defense-in-depth, but
            // keeping every federation read on the pooled view removes the whole class.
            let db = indexer.decoderDb.apiView();
            try {
                let rows = await db.getReorgEventsSince(v.since_id, v.limit);
                // Live REORG_HALT probe so the hub can tell "no recent reorgs" apart from
                // "decoder halted, history frozen". Best-effort: a probe fault falls back to the
                // indexer's last-known flag rather than failing the whole read.
                let decoderReorgHalted;
                try {
                    // Route through the same apiView db (pool-direct, never the block tx connection).
                    let probe = await db.isReorgHalted();
                    decoderReorgHalted = !!(probe && probe.halted);
                } catch (probeErr) {
                    decoderReorgHalted = !!indexer.decoderReorgHalted;
                }
                return reorgHistoryQuery.buildReorgHistoryResponse(rows,
                    { block_index: v.block_index, block_hash: v.block_hash },
                    { decoderReorgHalted });
            } catch (err) {
                getLogger().error('getreorghistory error:', err);
                return { error: 'failed to look up reorg history' };
            }
        },
    };
}

module.exports = { buildReorgHistoryRpc: reorgHistoryRpc };
