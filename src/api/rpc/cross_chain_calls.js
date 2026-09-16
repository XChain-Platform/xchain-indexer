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
 * XChain Indexer - JSON-RPC cross-chain call family: pending XCALL requests and execution results.
 *
 * Each group factory below closes over the context object src/api.js builds
 * (apiContext) and returns its methods verbatim; src/api/rpc/index.js merges
 * every family into the one controller the JSON-RPC router dispatches on.
 *
 * The single-call read getcrosschaincall is the family's third method and stays in
 * src/api.js: a hub guard reads that handler by the entry's literal path.
 *
 ********************************************************************/

const { getLogger } = require('../../observability/index.js');

function buildCrossChainCallsRpc(ctx){
    return Object.assign({}, pendingCrossChainCallsRpc(ctx), crossChainCallResultRpc(ctx));
}

// Pending XCALL v0 (cross-chain call request) rows awaiting federation
// dispatch. Used by xchain-hub's CrossChainCallEngine to discover work;
// the hub confirmation-gates on (block_index, latest_block_index) and
// dedupes against its own cross_chain_calls table.
// Body: { limit?: number }
function pendingCrossChainCallsRpc({ indexer }){
    return {
        async getpendingcrosschaincalls({limit}){
            if(!indexer.indexerDb)
                return { error: 'indexer database not ready' };
            let max = Number(limit);
            if(!Number.isFinite(max) || max <= 0) max = 100;
            if(max > 500) max = 500;
            // Federation READ isolation: committed-only, off the block tx.
            let db = indexer.indexerDb.apiView();
            try {
                let latest = await db.getLatestBlockIndex();
                // Source-chain reorg fence: stamp each call with this chain's current
                // push generation. The hub copies it onto the dispatch row (and the result row
                // inherits it), so a source-keyed deferred retraction fences by generation. Per-COIN.
                // Read the generation BEFORE the rows: the rollback bumps the
                // generation atomically with deleting the orphaned rows, so gen-first is safe wherever
                // that commit lands, while rows-then-gen could stamp a pre-commit orphan with the
                // post-commit generation and let it escape the fence. See getopencrosschainorders
                // (src/api/rpc/orders.js).
                let pushGeneration = await db.getPushGeneration(indexer.config['COIN']);
                let rows   = await db.getPendingCrossChainCallRequests(max);
                for(let c of rows) c.push_generation = pushGeneration;
                return {
                    latest_block_index: latest,
                    network:            indexer.config['NETWORK'],
                    count:              rows.length,
                    calls:              rows
                };
            } catch (err) {
                getLogger().error('getpendingcrosschaincalls error:', err);
                return { error: 'failed to look up pending cross-chain calls' };
            }
        },
    };
}

// Execution outcome of an injected cross-chain call on THIS (target) chain.
// Used by the hub to relay the result back to the source chain, and by hub
// followers to re-verify a proposed result row byte-for-byte.
// Body: { call_id }
function crossChainCallResultRpc({ indexer }){
    return {
        async getcrosschaincallresult({call_id}){
            if(!indexer.indexerDb)
                return { error: 'indexer database not ready' };
            if(!call_id || !/^[0-9a-fA-F]{64}$/.test(String(call_id)))
                return { error: 'call_id must be a 64-hex id' };
            // Federation READ isolation: committed-only, off the block tx.
            let db = indexer.indexerDb.apiView();
            try {
                let latest = await db.getLatestBlockIndex();
                let row    = await db.getCrossChainCallExecutionById(String(call_id));
                if(!row){
                    let res = { exists: false, network: indexer.config['NETWORK'], latest_block_index: latest };
                    // Surface refusal diagnostics: a quorum-starved dispatch has
                    // no execution row, but the injection pass records WHY it keeps being
                    // refused. Node-local advisory only (never quorum-verified relay data).
                    let rejection = await db.getCrossChainCallRejectionById(String(call_id));
                    if(rejection){
                        res.rejection = {
                            reason:      rejection.reason,
                            detail:      rejection.detail || '',
                            attempts:    Number(rejection.attempts),
                            first_block: Number(rejection.first_block),
                            last_block:  Number(rejection.last_block)
                        };
                    }
                    return res;
                }
                return {
                    exists:               true,
                    network:              indexer.config['NETWORK'],
                    latest_block_index:   latest,
                    executed_block_index: Number(row.block_index),
                    status:               row.result_status,
                    return_payload_b64:   row.return_payload_b64 || '',
                    gas_used:             Number(row.gas_used)
                };
            } catch (err) {
                getLogger().error('getcrosschaincallresult error:', err);
                return { error: 'failed to look up cross-chain call result' };
            }
        },
    };
}

module.exports = { buildCrossChainCallsRpc };
