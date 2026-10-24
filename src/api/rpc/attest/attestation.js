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

const { getLogger } = require('../../../observability/index.js');
const rpcParams = require('../params.js');

function attestationPageParams({ limit, after_block_index, after_action_index }){
    // Default and cap the page size while refusing malformed explicit values.
    let page = rpcParams.limit(limit, { defaultValue: 100, max: 500 });
    if(page.error) return { error: page.error };
    let hasBlock = after_block_index !== undefined && after_block_index !== null;
    let hasAction = after_action_index !== undefined && after_action_index !== null;
    // Require both columns of the keyset cursor so no request silently restarts at page one.
    if(hasBlock !== hasAction)
        return { error: 'after_block_index and after_action_index must be supplied together' };
    if(!hasBlock) return { max: page.value, cursor: null };
    // Parse both cursor columns as exact row indexes.
    let block = rpcParams.integer(after_block_index, { name: 'after_block_index', min: 0 });
    let action = rpcParams.integer(after_action_index, { name: 'after_action_index', min: 0 });
    if(block.error || action.error) return { error: block.error || action.error };
    return {
        max: page.value,
        cursor: { after_block_index: block.value, after_action_index: action.value }
    };
}

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
            let page = attestationPageParams({ limit, after_block_index, after_action_index });
            if(page.error) return { error: page.error };
            // Bound the optional provider filter before it reaches the database query.
            let provider = rpcParams.string(provider_id, { name: 'provider_id', maxLength: 255 });
            if(provider.error) return { error: provider.error };
            // Federation READ isolation: committed-only, off the block tx.
            let db = indexer.indexerDb.apiView();
            try {
                let latest  = await db.getLatestBlockIndex();
                let rows    = await db.getPendingAttestationRequests(provider.value, page.max, page.cursor);
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
            let page = attestationPageParams({ limit, after_block_index, after_action_index });
            if(page.error) return { error: page.error };
            // Bound the optional request filter before it reaches the database query.
            let request = rpcParams.string(request_id, { name: 'request_id', maxLength: 255 });
            if(request.error) return { error: request.error };
            // Federation READ isolation: committed-only, off the block tx.
            let db = indexer.indexerDb.apiView();
            try {
                let latest = await db.getLatestBlockIndex();
                let rows   = await db.getRelayedAttestationRequests(
                    indexer.config['COIN'], request.value, page.max, page.cursor);
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
            // Require an exact positive action row index.
            let parsed = rpcParams.integer(action_index, { name: 'action_index', min: 1 });
            if(parsed.error) return { error: parsed.error };
            let idx = parsed.value;
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
