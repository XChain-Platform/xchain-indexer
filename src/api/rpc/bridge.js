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
 * XChain Indexer - JSON-RPC bridge family: pending XBRIDGE legs, one transfer, balances and the escrow proof.
 *
 * Each group factory below closes over the context object src/api.js builds
 * (apiContext) and returns its methods verbatim; src/api/rpc/index.js merges
 * every family into the one controller the JSON-RPC router dispatches on.
 *
 ********************************************************************/

const { getLogger } = require('../../observability/index.js');

/**
 * SEAM (no handler here; served by getpendingbridgetransfers and
 * getbridgetransfer). This typedef is the row shape the hub's
 * CrossChainBridgeEngine polls for and signs, frozen up front so the read handlers,
 * the hub engine and the wallet cannot each invent a different field name.
 *
 * One row per CONFIRMED, not-yet-finalized source leg on this chain: a lock
 * (XBRIDGE v0/v3) or a burn (XBRIDGE v1/v4). The hub confirmation-gates on
 * (block_index, latest_block_index) and dedupes against its own bridge_transfers
 * table, the getpendingcrosschaincalls contract (./cross_chain_calls.js).
 *
 * @typedef {Object} PendingBridgeTransfer
 * @property {'lock'|'burn'} transfer_kind - DERIVED from the source leg's version,
 *   never a wire field: v0/v3 are locks, v1/v4 are burns
 * @property {string} src_chain         - this chain's coin (the leg was mined here)
 * @property {number} src_action_index  - the lock or burn action_index on this chain
 * @property {string} src_address       - the locking or burning source address
 * @property {string} dest_chain        - coin the credit is to land on
 * @property {string} dest_address      - address to credit on dest_chain
 * @property {string} tick              - the action's tick; v4 burns retain the rooted
 *   <ORIGIN>.<NAME> form so the destination can identify the native asset unambiguously
 * @property {number} decimals          - the token's DECIMALS as read at the leg's
 *   OWN block; the precision `amount` is formatted at, and signed into the record
 * @property {string} amount            - decimal string at `decimals` fractional
 *   digits; a string because amounts are bignumber math, never a JSON number
 * @property {number} min_depth         - the origin row's MIN_DEPTH as stamped by
 *   the lock at its own block, 0 when unset. The federation applies
 *   max(coins.resolveConfirmations(src_chain, network), min_depth), so it is
 *   raise-only. Stamped rather than re-read at poll time: a later edit of the
 *   origin row must never make an accepted lock un-signable, nor let two followers
 *   disagree. Nothing is signed for it
 * @property {number} block_index       - height the source leg was mined at
 * @property {number} confirmations     - latest_block_index - block_index + 1
 * @property {string} tx_hash           - the source leg's transaction hash
 */

function buildBridgeRpc(ctx){
    return Object.assign({}, pendingBridgeTransfersRpc(ctx), bridgeTransferReadsRpc(ctx), escrowProofRpc(ctx));
}

// Pending XBRIDGE locks (v0/v3) and burns (v1/v4) on THIS chain, for the hub's
// CrossChainBridgeEngine poll. Open read: not in
// WRITE_METHODS, GATED_EXEC_METHODS or FEDERATION_READ_METHODS. Returns the
// PendingBridgeTransfer shape at the top of this file; confirmation-gating and dedup against the
// hub's own bridge_transfers table are the hub's job, the getpendingcrosschaincalls
// convention.
// Body: { limit?: number }
function pendingBridgeTransfersRpc({ indexer }){
    return {
        async getpendingbridgetransfers({limit}){
            if(!indexer.indexerDb)
                return { error: 'indexer database not ready' };
            let max = Number(limit);
            if(!Number.isFinite(max) || max <= 0) max = 100;
            if(max > 500) max = 500;
            // Federation READ isolation: committed-only, off the block tx.
            let db = indexer.indexerDb.apiView();
            try {
                let latest = await db.getLatestBlockIndex();
                // Source-chain reorg fence, the getpendingcrosschaincalls convention: read
                // the generation BEFORE the rows so a rollback that lands
                // between the two reads cannot stamp a pre-commit orphan with the post-commit
                // generation and let it escape the retraction fence.
                let pushGeneration = await db.getPushGeneration(indexer.config['COIN']);
                let rows   = await db.getPendingBridgeTransfers(max);
                let transfers = rows.map(r => {
                    let version = Number(r.version);
                    return {
                        transfer_kind:    (version === 0 || version === 3) ? 'lock' : 'burn',
                        src_chain:        indexer.config['COIN'],
                        src_action_index: Number(r.action_index),
                        src_address:      r.src_address,
                        dest_chain:       r.dest_chain,
                        dest_address:     r.dest_address,
                        tick:             r.tick,
                        decimals:         (r.decimals    != null) ? Number(r.decimals)   : 0,
                        amount:           String(r.amount),
                        min_depth:        (r.min_depth   != null) ? Number(r.min_depth)  : 0,
                        block_index:      Number(r.block_index),
                        confirmations:    latest - Number(r.block_index) + 1,
                        tx_hash:          r.tx_hash,
                        push_generation:  pushGeneration
                    };
                });
                return {
                    latest_block_index: latest,
                    network:            indexer.config['NETWORK'],
                    count:              transfers.length,
                    transfers:          transfers
                };
            } catch (err) {
                getLogger().error('getpendingbridgetransfers error:', err);
                return { error: 'failed to look up pending bridge transfers' };
            }
        },
    };
}

function bridgeTransferReadsRpc({ indexer }){
    return {
        // Single bridge_transfers mirror row by transfer_id: the targeted re-verification a
        // hub follower runs before co-signing a leader's proposed row, the getcrosschaincall
        // convention. Open read.
        // Body: { transfer_id }
        async getbridgetransfer({transfer_id}){
            if(!indexer.indexerDb)
                return { error: 'indexer database not ready' };
            if(!transfer_id || !/^[0-9a-fA-F]{64}$/.test(String(transfer_id)))
                return { error: 'transfer_id must be a 64-hex id' };
            let db = indexer.indexerDb.apiView();
            try {
                let latest = await db.getLatestBlockIndex();
                let row    = await db.getBridgeTransferById(String(transfer_id).toLowerCase());
                if(!row)
                    return { exists: false, network: indexer.config['NETWORK'], latest_block_index: latest };
                return Object.assign({ exists: true, latest_block_index: latest }, row);
            } catch (err) {
                getLogger().error('getbridgetransfer error:', err);
                return { error: 'failed to look up bridge transfer' };
            }
        },

        // The chain-state read getbridgeinvariant needs (the hub's
        // CrossChainBridgeEngine.readBridgeBalances is the caller). Open read. Answers for
        // ONE tick at a time: { supply, escrow: { <COIN>: balance } }, escrow keyed by the
        // bare coin (the hub's escrowFor accepts either spelling).
        // Body: { tick }
        async getbridgebalances({tick}){
            if(!indexer.indexerDb)
                return { error: 'indexer database not ready' };
            if(!tick)
                return { error: 'tick required' };
            let db = indexer.indexerDb.apiView();
            try {
                return await db.getBridgeBalances(String(tick));
            } catch (err) {
                getLogger().error('getbridgebalances error:', err);
                return { error: 'failed to look up bridge balances' };
            }
        },
    };
}

// The escrow proof envelope: bridge_checkpoint_check.js's
// header documents the exact shape and verifyEscrowAgainstCheckpoint verifies it.
// Producer-side only: this reports what THIS chain committed at block_index and lets
// the caller (the bridge settle pass) bind its own already-verified checkpoint to it.
// Open read.
// Body: { address, tick, block_index }
function escrowProofRpc({ indexer }){
    return {
        async getbridgeescrowproof({address, tick, block_index}){
            if(!indexer.indexerDb)
                return { error: 'indexer database not ready' };
            if(!address || !tick)
                return { error: 'address and tick required' };
            let height = Number(block_index);
            if(!Number.isFinite(height) || !Number.isInteger(height) || height < 0)
                return { error: 'block_index must be a non-negative integer' };
            let db = indexer.indexerDb.apiView();
            try {
                let envelope = await db.getBridgeEscrowProof(String(address), String(tick), height);
                if(!envelope)
                    return { error: 'no provable escrow state at that block_index' };
                return envelope;
            } catch (err) {
                getLogger().error('getbridgeescrowproof error:', err);
                return { error: 'failed to build escrow proof' };
            }
        },
    };
}

module.exports = { buildBridgeRpc };
