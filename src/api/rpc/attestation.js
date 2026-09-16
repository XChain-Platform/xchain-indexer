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
 * XChain Indexer - JSON-RPC attestation family: the pending and relayed ATTEST queues, and one action's depth.
 *
 * Each group factory below closes over the context object src/api.js builds
 * (apiContext) and returns its methods verbatim; src/api/rpc/index.js merges
 * every family into the one controller the JSON-RPC router dispatches on.
 *
 ********************************************************************/

const { getLogger } = require('../../observability/index.js');

function buildAttestationRpc(ctx){
    return Object.assign({}, pendingAttestationRpc(ctx), relayedAttestationRpc(ctx), actionConfirmationsRpc(ctx));
}

// List ATTEST v0 (request) rows currently awaiting validator fulfillment.
// Used by xchain-hub's AttestationRound to discover work. Returns
// latest_block_index alongside so the hub can compute its
// confirmation-wait threshold (block_index + CONFIRMATIONS <= latest)
// in a single round-trip without a follow-up getlatestblock call.
// Body: { provider_id?: string, limit?: number,
//         after_block_index?: number, after_action_index?: number }
//   The after_* pair is a keyset cursor for paging past the oldest
//   `limit` rows (see getPendingAttestationRequests).
function pendingAttestationRpc({ indexer }){
    return {
        async getpendingattestation_requests({provider_id, limit, after_block_index, after_action_index}){
            if(!indexer.indexerDb)
                return { error: 'indexer database not ready' };
            let max = Number(limit);
            if(!Number.isFinite(max) || max <= 0) max = 100;
            if(max > 500) max = 500;
            // Optional keyset cursor: caller pages forward by passing the last
            // (block_index, action_index) it consumed. Only honoured when both
            // components are present and finite; otherwise a full sweep is returned.
            let cursor = null;
            if(Number.isFinite(Number(after_block_index)) && Number.isFinite(Number(after_action_index))){
                cursor = { after_block_index, after_action_index };
            }
            // Federation READ isolation: committed-only, off the block tx.
            let db = indexer.indexerDb.apiView();
            try {
                let latest  = await db.getLatestBlockIndex();
                let rows    = await db.getPendingAttestationRequests(provider_id, max, cursor);
                return {
                    latest_block_index: latest,
                    count:              rows.length,
                    requests:           rows
                };
            } catch (err) {
                getLogger().error('getpendingattestation_requests error:', err);
                return { error: 'failed to look up pending attestation requests' };
            }
        },
    };
}

// Attestation relay: list the ATTEST v0 requests this chain holds only as a
// MATERIALIZED relay leg (an origin_chain that is not this coin), at any
// lifecycle status, each carrying its terminal response when one exists.
// xchain-hub's AttestationRelay uses it for both halves of the round trip: to
// know a request is already on this chain whatever its status (the pending
// queue alone answers that only while it is pending, so a fulfilled one read as
// never materialized and drew a duplicate v3), and to discover the responses it
// owes back as an ATTEST v4. A co-signing peer re-reads ONE row through it
// (request_id filter) to independently confirm a leader's proposed v4 rather
// than trusting the proposal. latest_block_index rides along so the caller can
// apply its confirmation depth without a follow-up getlatestblock.
// Body: { request_id?: string, limit?: number,
//         after_block_index?: number, after_action_index?: number }
function relayedAttestationRpc({ indexer }){
    return {
        async getrelayedattestation_requests({request_id, limit, after_block_index, after_action_index}){
            if(!indexer.indexerDb)
                return { error: 'indexer database not ready' };
            let max = Number(limit);
            if(!Number.isFinite(max) || max <= 0) max = 100;
            if(max > 500) max = 500;
            let cursor = null;
            if(Number.isFinite(Number(after_block_index)) && Number.isFinite(Number(after_action_index))){
                cursor = { after_block_index, after_action_index };
            }
            // Federation READ isolation: committed-only, off the block tx.
            let db = indexer.indexerDb.apiView();
            try {
                let latest = await db.getLatestBlockIndex();
                let rows   = await db.getRelayedAttestationRequests(
                    indexer.config['COIN'], request_id, max, cursor);
                return {
                    latest_block_index: latest,
                    count:              rows.length,
                    requests:           rows
                };
            } catch (err) {
                getLogger().error('getrelayedattestation_requests error:', err);
                return { error: 'failed to look up relayed attestation requests' };
            }
        },
    };
}

// Existence + confirmation depth for a single action. Lets the xchain-hub
// federation verify that a proposed cross-chain source action really exists
// on this chain (and how deep it is buried) before co-signing an
// attestation, instead of trusting the proposer's claim. Returns the latest
// indexed block in the same round-trip so depth and tip are one snapshot.
// Body: { action_index }
function actionConfirmationsRpc({ indexer }){
    return {
        async getactionconfirmations({action_index}){
            if(!indexer.indexerDb)
                return { error: 'indexer database not ready' };
            let idx = Number(action_index);
            if(!Number.isInteger(idx) || idx <= 0)
                return { error: 'action_index must be a positive integer' };
            // Federation READ isolation: committed-only, off the block tx.
            let db = indexer.indexerDb.apiView();
            try {
                let latest = await db.getLatestBlockIndex();
                let row    = await db.getActionInfo(idx);
                if(!row){
                    return {
                        coin:               indexer.config['COIN'],
                        network:            indexer.config['NETWORK'],
                        action_index:       idx,
                        exists:             false,
                        latest_block_index: latest,
                        confirmations:      0
                    };
                }
                let blockIndex = Number(row.block_index);
                return {
                    coin:               indexer.config['COIN'],
                    network:            indexer.config['NETWORK'],
                    action_index:       idx,
                    exists:             true,
                    action:             row.action,
                    block_index:        blockIndex,
                    latest_block_index: latest,
                    confirmations:      (latest >= blockIndex) ? (latest - blockIndex + 1) : 0
                };
            } catch (err) {
                getLogger().error('getactionconfirmations error:', err);
                return { error: 'failed to look up action confirmations' };
            }
        },
    };
}

module.exports = { buildAttestationRpc };
