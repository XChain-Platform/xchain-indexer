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
 * XCALL result delivery: the gates a mirrored result row passes before the
 * requester's callback fires, and the retirement of a row that can never pass.
 *
 * The quorum verification itself stays on the handler (index.js
 * verifyResultQuorum / resultCanonical): it reads the stake-weighted-quorum,
 * admission and equivocation activation twins, and the suites that re-arm those
 * twins purge and re-require the handler entry alone, so a copy captured in
 * this module would keep the old arm.
 *
 * Called with the handler as `this` (index.js delegates with .call).
 *
 ********************************************************************/

'use strict';

const { rethrowIfInfraFault } = require('../../consensus/fault_guard.js');
const { getLogger } = require('../../observability/index.js');
// Vendored protocol constants; the orphan grace is the age-out clock for a
// result row with no local request (see resultAgedOut).
const PROTO = require('../../protocol/constants.js');

// Has an undeliverable result row aged out, i.e. can it no longer become
// deliverable on any branch this chain could still adopt?
//
// Two clocks, both node-invariant, both read only from consensus inputs (the
// block being processed and the quorum-signed mirror row), never wall-clock:
//
//   request present  the request's OWN deadline_block is exact. Past it the
//                    request is terminal (the expiry pass has flipped it, or a
//                    result already completed it), so no future block can turn
//                    this row into a delivered callback. Used for the routing
//                    mismatch and definitively-unquorate cases.
//
//   request absent   nothing local carries a deadline, and the mirrored row has
//                    no deadline field, so the clock is the row's quorum-signed
//                    effective_time plus XCALL_RESULT_ORPHAN_GRACE_SECONDS of
//                    block time. The federation only signs a result after the
//                    request is buried at its source chain's relay confirmation
//                    depth, and the grace covers the deepest of those windows, so
//                    a request still absent that far past effectiveness is absent
//                    because its branch is gone. Should a deeper-than-designed
//                    reorg restore it anyway, the retirement row is anchored to a
//                    rollback-able action_index and is erased with it.
//
// A row deferred because the capability snapshot is not mirrored yet never reaches
// here (processResult returns earlier): that row is still expected to deliver, and
// resultSuppressesExpiry keeps its request alive to receive it.
function resultAgedOut(r, request, data){
    if(request){
        let deadline = parseInt(request.deadline_block);
        let block    = parseInt(data['BLOCK_INDEX']);
        if(!Number.isFinite(deadline) || !Number.isFinite(block)) return false;
        return block > deadline;
    }
    // parseInt, not Number: Number(null) is 0, which would read a row with a missing
    // effective_time as infinitely old and retire it on sight.
    let effective = parseInt(r.effective_time);
    let blockTime = parseInt(data['BLOCK_TIME']);
    if(!Number.isFinite(effective) || !Number.isFinite(blockTime)) return false;
    return (blockTime - effective) >= PROTO.XCALL_RESULT_ORPHAN_GRACE_SECONDS;
}

// Retire a result row this chain can never deliver, so it stops being re-selected
// by the capped delivery pass every block. Returns true when the row was
// retired (the caller must then stop processing it).
//
// Without this, an undeliverable row is rejected on every block and pruned by
// nothing, because pruning is keyed on a recorded callback and the reject paths
// record none. getEffectiveUnprocessedCallResults orders by (snapshot_block,
// call_id) and the pass takes only XCALL_MAX_CALLS_PER_BLOCK rows, so as few as 25
// such rows at a low snapshot_block hold the head of the queue forever and starve
// every legitimate result behind them (observed live: 229 undeliverable rows ahead
// of a real one starved it at the tail of a 25-row head slice).
//
// CONSENSUS-VISIBLE, deliberately. Retirement mints an actions row and frees a slot
// in a capped per-block pass, which decides which block a real callback EXECUTE
// lands in; a node-local retirement would fork the delivered set against a node that
// kept the row. So it is flag-day gated (ORPHAN_RETIREMENT_GATE), decided purely
// from consensus inputs (resultAgedOut), and written against a rollback-able
// action_index like every other cross-chain bookkeeping row, so a source-chain reorg
// that restores the missing request also erases the retirement and lets the result
// deliver normally on the branch that carries the request.
//
// It delivers NO callback: the requesting contract, if it exists at all, hears the
// 'expired' outcome from the deadline path, which is the only outcome a chain that
// never saw the request can agree on.
async function retireUndeliverableResult(r, data, callId, request, reason, gate){
    if(!(await this.actions.protocolChanges.isEnabled(gate, data['BLOCK_INDEX'])))
        return false;
    if(!this.resultAgedOut(r, request, data))
        return false;

    // Mint the retirement's own action_index (the rollback anchor). Minted only once
    // the row is genuinely retired: an index minted on a row that stays in the queue
    // would move every later action_index for nothing.
    data['ACTION_INDEX'] = await this.indexerDb.createActionIndex({
        ACTION:      'XCALL',
        BLOCK_INDEX: data['BLOCK_INDEX']
    }, true);

    getLogger().info("\t XCALL result : id=" + callId.substring(0,16) + '...' +
                ' : undeliverable (' + reason + ') and aged out, retiring' +
                ' : block=' + data['BLOCK_INDEX']);

    await this.indexerDb.recordCrossChainCallCallback(
        data['ACTION_INDEX'], callId, 'retired:' + reason, data['BLOCK_INDEX']);
    return true;
}

// Deliver a result row that has passed every gate: mint the processing action,
// apply the exactly-once interlock against the deadline-expiry path, inject the
// requester's callback and record the outcome. Split from the gates above only
// for length; it runs in the same order, and processResult reaches it on exactly
// the rows that pass every one of those gates.
async function deliverResult(r, data, callId, request, q){
    // Mint the internal processing action (rollback anchor for the callback record).
    data['ACTION_INDEX'] = await this.indexerDb.createActionIndex({
        ACTION:      'XCALL',
        BLOCK_INDEX: data['BLOCK_INDEX']
    }, true);

    let resultStatus  = String(r.result_status || 'error');
    let resultPayload = '';
    try { resultPayload = Buffer.from(String(r.return_payload_b64 || ''), 'base64').toString('utf8'); }
    catch(_){ resultPayload = ''; }

    // Exactly-once interlock vs the deadline-expiry path.
    // Both paths are block-height-driven and share request_status: whichever
    // reaches terminal first wins; the loser records itself as skipped so the
    // result row is never re-evaluated (idempotency row below) but the contract
    // hears exactly one outcome.
    if(request.request_status !== 'pending'){
        getLogger().info("\t XCALL result : id=" + callId.substring(0,16) + '... : request already ' + request.request_status + ', recording skip');
        await this.indexerDb.recordCrossChainCallCallback(
            data['ACTION_INDEX'], callId, 'skipped:' + request.request_status, data['BLOCK_INDEX']);
        return;
    }

    getLogger().info("\t XCALL result : id=" + callId.substring(0,16) + '...' +
                ' : from=' + r.target_chain + ' : status=' + resultStatus +
                ' : sigs=' + q.validSigners.length + '/' + q.N);

    // Flip to terminal BEFORE injecting (interlock order; also feeds getCallResult).
    await this.indexerDb.updateCrossChainCallRequestStatus(callId, 'completed', resultStatus, resultPayload, data['BLOCK_INDEX']);

    // Inject the callback; a failing callback does NOT roll back the bookkeeping.
    try {
        let callbackActionIndex = await this.injectCallback(request, data, resultStatus, resultPayload);
        if(callbackActionIndex)
            await this.indexerDb.setCrossChainCallCallbackIndex(callId, callbackActionIndex);
    } catch(e){
        // Infra faults must halt the block, not record a callback-less result
        // this validator alone commits (see consensus/fault_guard.js).
        rethrowIfInfraFault(e);
        getLogger().warn('XCALL result callback injection failed:', e);
    }

    await this.indexerDb.recordCrossChainCallCallback(
        data['ACTION_INDEX'], callId, resultStatus, data['BLOCK_INDEX']);

    await this.mapper.createMappings(data);
}

// Process one mirrored, effective result row for a request THIS chain originated
// (driven by utility.processCrossChainCalls in (snapshot_block, call_id) order).
// Verifies the 2f+1 signatures, applies the exactly-once interlock against the
// deadline-expiry path, injects the requester's callback, and records the
// processing in cross_chain_call_callbacks (idempotency + rollback anchor).
// Every exit that is NOT a deferral records something in that table, so no row can
// sit in the capped queue forever: delivery and the interlock record their outcome,
// and the three undeliverable exits retire the row once it has aged out.
async function processResult(r, data){
    let callId = String(r.call_id || '').toLowerCase();

    // Network guard (belt-and-suspenders; the query pre-filters).
    if(String(r.network || '') !== String(this.config['NETWORK'] || '')) return;

    // The result must correspond to a request THIS chain knows, with matching
    // routing: a forged result for someone else's call_id can never deliver.
    let request = await this.indexerDb.getCrossChainCallRequestById(callId);
    if(!request){
        if(await this.retireUndeliverableResult(r, data, callId, null, 'no_request')) return;
        getLogger().warn("\t XCALL result : id=" + callId.substring(0,16) + '... : no matching local request, skipping');
        return;
    }
    if(String(request.target_chain) !== String(r.target_chain)){
        if(await this.retireUndeliverableResult(r, data, callId, request, 'routing')) return;
        getLogger().warn("\t XCALL result : id=" + callId.substring(0,16) + '... : target_chain mismatch, skipping');
        return;
    }

    // Verify the cross_chain quorum over the result canonical.
    let q = await this.verifyResultQuorum(r);
    if(!q.synced){
        // Snapshot not mirrored yet; defer (the barriers front-stop this; see xexec.js).
        getLogger().info("\t XCALL result : id=" + callId.substring(0,16) + '... : capability snapshot not synced, deferring');
        return;
    }
    let N = q.N, validSigners = q.validSigners;
    if(!q.quorumMet){
        if(await this.retireUndeliverableResult(r, data, callId, request, 'no_quorum')) return;
        getLogger().warn("\t XCALL result : id=" + callId.substring(0,16) + '... : insufficient ' + (q.weighted ? 'signer stake' : 'valid signatures (' + validSigners.length + '/' + N + ')') + ', skipping');
        return;
    }

    await deliverResult.call(this, r, data, callId, request, q);
}

module.exports = { resultAgedOut, retireUndeliverableResult, processResult };
