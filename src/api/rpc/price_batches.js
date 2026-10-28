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
const { committedView } = require('../health');
const { getLogger } = require('../../observability/index.js');
const rpcParams = require('./params.js');

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
// Protocol time of each distinct landing block in rows, read from the DECODER database
// the way block_parse.js takes data['BLOCK_TIME'] for the batch's pushpricebatch, through
// its committed view (protocolTimeForStoredBlock leaves the hot-path memo alone). An
// unresolvable block, or no decoder database, is left out, so its batch answers null.
async function landingBlockTimes(decoderDb, rows){
    let times = new Map();
    if(!decoderDb) return times;
    let db = committedView(decoderDb);
    for(let row of (Array.isArray(rows) ? rows : [])){
        if(row.block_index === null || row.block_index === undefined) continue;
        let blockIndex = Number(row.block_index);
        if(!Number.isSafeInteger(blockIndex) || times.has(blockIndex)) continue;
        let time = await db.protocolTimeForStoredBlock(blockIndex);
        if(time !== false && time !== null && time !== undefined) times.set(blockIndex, Number(time));
    }
    return times;
}

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
                let times  = await landingBlockTimes(indexer.decoderDb, rows);
                return priceBatchQuery.buildPriceBatchesResponse(latest, rows, v, times);
            } catch (err) {
                getLogger().error('getpricebatches error:', err);
                return { error: 'failed to look up price batches' };
            }
        },

        // Rebuild the exact body this batch delivered to pushpricebatch. Only a
        // committed, valid PRICE v0 batch qualifies; invalid and rolled-back rows
        // deliberately have the same not-found answer.
        async getpricebatchpayload({action_index}){
            if(!indexer.indexerDb)
                return { error: 'indexer database not ready' };
            let parsed = rpcParams.integer(action_index, { name: 'action_index', min: 0 });
            if(parsed.error) return { error: parsed.error };
            let db = indexer.indexerDb.apiView();
            try {
                // Read the fence first. A rollback after this read either makes the
                // body disappear or leaves it paired with the pre-rollback generation,
                // which the hub rejects after processing the retraction.
                let pushGeneration = await db.getPushGeneration(indexer.config['COIN']);
                let row = await db.findValidPriceBatchPayload(parsed.value);
                if(!row) return { error: 'valid price batch not found' };
                let rounds = JSON.parse(row.rounds_json);
                let sigs = JSON.parse(row.sigs_json);
                if(!Array.isArray(rounds) || rounds.length === 0 || !Array.isArray(sigs))
                    return { error: 'stored price batch payload is invalid' };
                let blockIndex = Number(row.block_index);
                let blockTime = await committedView(indexer.decoderDb).protocolTimeForStoredBlock(blockIndex);
                if(blockTime === false || blockTime === null || blockTime === undefined)
                    return { error: 'price batch landing block time is unavailable' };
                return {
                    source_chain: indexer.config['COIN'],
                    first_round: Number(row.batch_first_round),
                    last_round: Number(row.batch_last_round),
                    btc_block_height: Number(rounds[rounds.length - 1].btc_block_height),
                    rounds: rounds,
                    block_time: Number(blockTime),
                    sigs: sigs,
                    action_index: Number(row.action_index),
                    block_index: blockIndex,
                    push_generation: Number(pushGeneration)
                };
            } catch (err) {
                getLogger().error('getpricebatchpayload error:', err);
                return { error: 'failed to rebuild price batch payload' };
            }
        },
    };
}

module.exports = { buildPriceBatchesRpc: priceBatchesRpc };
