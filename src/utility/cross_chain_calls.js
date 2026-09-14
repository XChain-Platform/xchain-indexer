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
 * XChain Indexer - Utility: cross-chain call passes
 *
 * The per-block cross-chain contract call passes: target-side XEXEC injection, source-side
 * result delivery and source-side deadline expiry, all under one per-block cap.
 *
 ********************************************************************/

'use strict';

// The per-block call cap. actions/xcall/index.js sets its static XCALL_MAX_CALLS_PER_BLOCK from
// this same protocol constant, so this is the number the handler declares. Read here, at the
// top of the file, from the leaf constants module rather than from the XCALL handler in the
// middle of a block: the action modules are constructed from the Utility class, and requiring
// the handler would pull that layer into this part, while protocol/constants.js requires nothing.
const { XCALL_MAX_CALLS_PER_BLOCK } = require('../protocol/constants.js');

// Step 1, TARGET side: an XEXEC for every effective, undispatched call targeting this chain.
// block_index keys the admission era in both call reads (db.mirrorBindClause).
async function injectTargetExecutions(actions, db, coin, network, block_index, block_time, cap){
    let dispatches = await db.getEffectiveUndispatchedCalls(coin, network, block_time, cap, block_index);
    for(let c of dispatches){
        let data = {};
        data['ACTION']      = 'XEXEC';
        data['BLOCK_INDEX'] = block_index;
        data['BLOCK_TIME']  = block_time;
        data['CALL']        = c;
        await actions.processAction('XEXEC', null, data, null);
    }
}

// 2. Deliver results for requests this chain originated, capped at
// XCALL_MAX_CALLS_PER_BLOCK. Fetch the full effective set (the cap is applied here as
// a deterministic slice) so step 3 can tell which requests already have a result
// available this block even when the cap defers their delivery to a later block.
//
// The uncapped fetch is what step 3's suppression map is built from, and on a block
// with nothing to expire that map is never read: the whole finalized-result backlog
// is dragged across the (possibly remote hub) connection every ~5s to serve nothing.
// Probe first with the SAME expiry predicate at LIMIT 1 and fall back to the plain
// per-block cap when it comes back empty. This is the identical row set either way:
// step 3's own expiry query is a SUBSET of this probe's, because pass 2 can only
// move a request OUT of the probe's set (updateCrossChainCallRequestStatus writes
// only the terminal 'completed'/'expired') and can never add one to it (a request
// created by a callback this block carries deadline_block = block_index +
// XCALL_MIN_DEADLINE_BLOCKS or more, so it cannot satisfy deadline_block <
// block_index at this height). Empty probe therefore proves empty expiry pass,
// which proves the map is dead. When the probe is non-empty nothing changes at all.
// The probe reads the same index the capped query at step 3 uses.
//
// Returns the full effective result set, which step 3's suppression map is built from.
async function deliverSourceResults(actions, db, coin, network, block_index, block_time, cap){
    let mayExpire  = (await db.getExpiredCrossChainCallRequests(block_index, 1)).length > 0;
    let allResults = await db.getEffectiveUnprocessedCallResults(coin, network, block_time,
                                mayExpire ? Number.MAX_SAFE_INTEGER : cap, block_index);
    let results = allResults.slice(0, cap);
    for(let r of results){
        let data = {};
        data['BLOCK_INDEX'] = block_index;
        data['BLOCK_TIME']  = block_time;
        await actions.actionXcall.processResult(r, data);
    }
    return allResults;
}

// 3. Expire pending requests past their deadline (mirrors processAttestationExpirations).
// A quorum-signed result that is effective this block but deferred past the per-block cap
// must still win over deadline expiry; otherwise the expiry pass flips the request to
// 'expired' and the carried-over result later records skipped:expired, delivering the wrong
// terminal status. Skip expiry for any request whose result is deliverable now (the full
// effective set, not just the capped slice delivered this block).
//
// Presence of a finalized result row is NOT sufficient: the hub mirror is untrusted (every
// other pass re-verifies its 2f+1 quorum). A Byzantine/buggy mirror can plant a finalized
// result row with invalid signatures - processResult rejects it on every block until it ages
// out, so if mere presence suppressed expiry the request would stall for that whole window
// and indexers mirroring different hubs would diverge on whether the
// v2 expiry action exists. (Such a row is no longer immortal:
// retireUndeliverableResult records a 'retired:' callback once resultAgedOut is true, and
// getEffectiveUnprocessedCallResults excludes any call_id with a recorded callback, so it
// then leaves the set. That bounds the backlog to the grace window; it does not make
// presence a safe suppression signal, which is what this paragraph is about.)
// So suppress expiry only when the result actually verifies (or the
// capability snapshot is not mirrored yet, i.e. it will still deliver) - resultSuppressesExpiry.
// Key on lowercased call_id: local result rows are canonical-lowercase, but a hub-mirrored
// call_id may arrive uppercase, so an unnormalized key would miss the lookup below and let
// a request expire even though a deliverable result exists. Lowercase on both insertion
// and lookup; the verbatim info.call_id still flows into the synthesized XCALL untouched.
// No-op for all-lowercase data.
async function expireSourceRequests(actions, db, allResults, block_index, block_time, cap){
    let resultsByCallId = new Map(allResults.map(r => [String(r.call_id).toLowerCase(), r]));
    // Cap the expiry pass at XCALL_MAX_CALLS_PER_BLOCK, same as dispatch/result: each expiry
    // synthesizes an XCALL v2 and runs a VM callback isolate, so an uncapped burst of
    // deadline-aligned requests would exceed BLOCK_PROCESS_TIMEOUT and deterministically wedge
    // every indexer on the chain. Remainder carries forward (getExpiredCrossChainCallRequests
    // orders by deadline_block, action_index, so the cutoff is node-invariant). The extra
    // verification below is bounded by this same cap (<=25 quorum checks/block).
    let expired = await db.getExpiredCrossChainCallRequests(block_index, cap);
    for(let info of expired){
        let pendingResult = resultsByCallId.get(String(info.call_id).toLowerCase());
        // effective + VERIFIED result wins over expiry at this block
        if(pendingResult && await actions.actionXcall.resultSuppressesExpiry(pendingResult)) continue;
        let data = {};
        data['ACTION']       = 'XCALL';
        data['FORMAT']       = 2;
        data['BLOCK_INDEX']  = block_index;
        data['BLOCK_TIME']   = block_time;
        data['CALL_ID']      = info.call_id;
        data['IS_SYNTHETIC'] = true;
        await actions.processAction('XCALL', [2, info.call_id], data, null);
    }
}

// Installed onto Utility.prototype by ../utility.js, non-enumerable; each method runs with
// `this` bound to the Utility instance, exactly as the class method it was.
module.exports = {

    // Cross-chain contract call passes (all three are deterministic per block):
    //  1. TARGET side: inject XEXEC for every effective, unexecuted dispatch row
    //     targeting this chain, in (snapshot_block, call_id) order, capped per block
    //     (overflow carries forward to the next block; never dropped, or operators
    //     that raced different mirror states would diverge on the cutoff).
    //  2. SOURCE side: deliver every effective, unprocessed result row for a
    //     request this chain originated (verify sigs → exactly-once interlock →
    //     inject the requester's callback), in (snapshot_block, call_id) order under
    //     the same cap.
    //  3. SOURCE side: synthesize XCALL v2 for pending requests whose
    //     deadline_block has passed (block-height-driven, so expiry fires
    //     identically on every operator even with the hub down.
    // The caller gates this on the call-sync + snapshot barriers so every operator
    // applies the same rows at the same block.
    async processCrossChainCalls(actions, db, block_index, block_time){
        let coin    = db.config['COIN'];
        let network = db.config['NETWORK'];
        let cap     = XCALL_MAX_CALLS_PER_BLOCK;

        // 1. Inject executions for dispatches targeting this chain.
        await injectTargetExecutions(actions, db, coin, network, block_index, block_time, cap);

        // 2. Deliver results for requests this chain originated (deliverSourceResults above).
        let allResults = await deliverSourceResults(actions, db, coin, network, block_index, block_time, cap);

        // 3. Expire pending requests past their deadline (expireSourceRequests above).
        await expireSourceRequests(actions, db, allResults, block_index, block_time, cap);
    }
};
