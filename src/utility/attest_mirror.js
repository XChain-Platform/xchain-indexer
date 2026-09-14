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
 * XChain Indexer - Utility: ATTEST response-mirror applier
 *
 * The per-block pass that applies the hub-mirrored ATTEST responses binding at a block as
 * synthetic ATTEST v1 actions. The binding rule itself, which responses bind and in what
 * order, is attest_mirror_select.js.
 *
 * BUILT BY THE ENTRY: the mirror-admission capture comes from ../utility.js, which re-takes
 * it on every re-require (see the require there for why). The bodies are plain named
 * functions that take that capture as an argument, and the factory at the foot only binds
 * the two installed methods to it, so every step stays its own named function.
 *
 ********************************************************************/

'use strict';

const { getLogger } = require('../observability/index.js');
const { selectApplicableAttestationResponses } = require('./attest_mirror_select.js');
// The per-block cap on mirror applies, from the same leaf constants module the binding rule
// reads it from (see attest_mirror_select.js for why never from the ATTEST handler).
const { ATTEST_MAX_MIRROR_APPLIES_PER_BLOCK } = require('../actions/attest/constants.js');
// Page size the mirror applier walks its applicability read in. NOT consensus and
// deliberately not exported: it shapes how many rows a node holds at once, never which
// rows bind (the read's order is total and the pages are disjoint slices of it), so
// nodes may disagree on it. Sized above the per-block cap by enough that an ordinary
// block fills the cap, or exhausts the pending set, in its first page, and matched to
// getMirroredAttestationResponses' own IN-list chunk so a page is one mirror round trip.
const ATTEST_MIRROR_APPLICABILITY_PAGE_ROWS = 500;

// Per-block hub-mirror ATTEST response applier pass.
// Runs at a PINNED pipeline position (immediately after
// processCrossChainCalls, before processAttestationExpirations) because the VM's
// attestation snapshot is inclusive of the current block: with this position no
// EXECUTE inside B sees a response bound at B and every EXECUTE in B+1 does, on
// every node. BTC-only, gated by the caller exactly as the barrier is.
//
// Synthesizes one ATTEST v1 action per binding row, the way the expiry sweep
// (processAttestationExpirations, in block_passes.js) synthesizes a v2. The handler verifies
// the row through the shared verifier and, only on success, mints the action and runs the v1
// effects; a row that fails is inert, so a synthesized-and-skipped row writes nothing.
async function processAttestationResponses(util, deps, actions, db, block_index, block_time){
    let network = db.config['NETWORK'];
    let cap     = ATTEST_MAX_MIRROR_APPLIES_PER_BLOCK;
    let walk    = await collectApplicableAttestations(util, db, network, block_index, block_time, cap);
    logEmptyAttestationPass(deps, db, network, block_index, block_time, walk);

    for(let item of walk.applicable){
        // FALL-THROUGH, and why the candidates ride inside the item rather than as
        // extra items in `applicable`: the handler re-gates on data['MIRROR_REQUEST'],
        // an in-memory snapshot taken once by the read above, so a second item for a
        // request the first item already bound would still read 'pending' off that
        // stale object and bind again, producing a second response row, a second fee
        // split, a second callback and a second action under the same synthetic
        // TX_HASH (it is namespaced on request_id alone). One request is dispatched
        // here at most once; the fall-through happens inside that one dispatch.
        // Below the height there is exactly one candidate and this is today's loop.
        await applyMirrorCandidates(actions, item, block_index, block_time);
    }
}

// BOUNDED READ. The per-block cap bounds the callbacks; this bounds the two reads
// that feed them. Both are walked one page at a time in the binding order and the
// walk stops as soon as the cap is filled, so a block that binds ten responses
// reads about one page instead of every pending request and then every one of
// their mirror rows.
//
// THE SELECTED SET IS UNCHANGED, which is the only thing that matters here: the
// read's ORDER BY is already the binding rule's total order, the selector re-sorts on the
// same key, and pages are disjoint consecutive slices of that order taken in
// order. So the sequence of applicable pairs this builds is the sequence the
// unpaged read built, and the first `cap` of it is the same prefix. A node paging
// at a different size, or not paging at all, still applies the same rows.
//
// The double-finalize tie-break is safe under paging for a separate reason: it is
// resolved per request_id, and every mirror row for an id is fetched with the page
// that carries that id, never split across pages.
//
// Returns { applicable, pendingSeen, mirrorSeen }. The selector is reached through the
// instance, as util.selectApplicableAttestationResponses, so a suite's stub of it still applies.
async function collectApplicableAttestations(util, db, network, block_index, block_time, cap){
    let applicable = [];
    let after      = null;
    // Counted for the diagnostic below, never used to decide anything.
    let pendingSeen = 0;
    let mirrorSeen  = 0;
    while(applicable.length < cap){
        // Local side first: with nothing pending there is nothing a mirror row can
        // bind to, which is the common case and costs one indexed read.
        let page = await db.getAttestationRequestsAwaitingMirrorResponse(
            block_index, ATTEST_MIRROR_APPLICABILITY_PAGE_ROWS, after);
        if(page.length === 0) break;
        let ids      = page.map(r => String(r.request_id || '').toLowerCase());
        // The block index rides along so the read and the selector below key the
        // admission era on the same B (the read's SQL clause and the selector's
        // predicate are the two spellings of one rule).
        let mirrored = await db.getMirroredAttestationResponses(network, ids, block_time, block_index);
        pendingSeen += page.length;
        mirrorSeen  += (mirrored || []).length;
        for(let item of util.selectApplicableAttestationResponses(mirrored, page, block_index, block_time, network,
                                                                  db.config['COIN'])){
            applicable.push(item);
            if(applicable.length >= cap) break;
        }
        if(page.length < ATTEST_MIRROR_APPLICABILITY_PAGE_ROWS) break;
        let last = page[page.length - 1];
        after = { block_index: last.block_index, action_index: last.action_index };
    }
    return { applicable, pendingSeen, mirrorSeen };
}

// WHY THIS BLOCK LOGS AT ALL. Every step above can decline silently: a
// request that is not pending, a deadline already passed, a flag day not
// yet active, an effective time still in the future, or simply no mirror
// row for any pending id. The result of each is the same empty list, and
// downstream that is indistinguishable from a mirror that never delivered
// a row. Three acceptance runs were spent attributing exactly this to the
// mirror, then to the roster, then to node catch-up, because the applier
// said nothing whatsoever about what it had considered and declined.
//
// Logged only when there IS something pending, so a chain with no
// attestation traffic stays quiet. Counts only: this runs per block.
function logEmptyAttestationPass(deps, db, network, block_index, block_time, walk){
    const { isMirrorAdmissionConsumerActive } = deps;
    let { applicable, pendingSeen, mirrorSeen } = walk;
    if(pendingSeen > 0 && applicable.length === 0){
        getLogger().info('processAttestationResponses: block ' + block_index + ' considered ' +
            pendingSeen + ' pending request(s) and ' + mirrorSeen + ' mirror row(s), applied 0. ' +
            'A mirror row binds only when its request is still pending, the deadline has not ' +
            'passed, the flag day is active at the REQUEST\'s block, and effective_time <= ' +
            block_time +
            // Above the admission activation the binding key is the height, so name it
            // too; the line's prefix is untouched for whoever greps for it.
            (isMirrorAdmissionConsumerActive(db.config['COIN'], network, block_index)
                ? ' (or, for a row carrying one, admit_block_btc <= ' + block_index + ')' : '') +
            '. If a row exists and none of those is the reason, the response is ' +
            'failing verification inside the handler and is inert.');
    }
}

// Dispatch ONE applicable request: try its candidates in order and stop at the first that
// binds. Below the height the item has exactly one candidate, its `response`.
async function applyMirrorCandidates(actions, item, block_index, block_time){
    let candidates = (item.candidates && item.candidates.length)
        ? item.candidates : [item.response];
    for(let candidate of candidates){
        // A FRESH data object per candidate. The handler writes its results into
        // this object (ACTION_INDEX, TX_HASH, STATUS), so reusing one across two
        // candidates would carry a skipped row's leftovers into the next attempt.
        let data = {};
        data['ACTION']       = 'ATTEST';
        data['FORMAT']       = 1;
        data['BLOCK_INDEX']  = block_index;
        // Load-bearing, not decoration: settleRequestFee reaches the broadcast-fee
        // reimbursement, which reads BLOCK_TIME for its fee-oracle lookup, and the
        // injected callback context carries it too.
        data['BLOCK_TIME']   = block_time;
        // No transaction is behind a mirror-applied response. That is the entire
        // point of the design, and the tests assert it on the resulting action.
        data['TX_INDEX']     = null;
        data['TX_VOUT']      = null;
        data['IS_SYNTHETIC'] = true;
        // The mirror row plus the LOCAL request row it binds to. Passing the pair is
        // what keeps the handler from re-reading (and re-ordering) state the binding
        // rule already decided.
        data['MIRROR_RESPONSE'] = candidate;
        data['MIRROR_REQUEST']  = item.request;
        data['REQUEST_ID']      = candidate.request_id;
        // Mirror the synthetic-action positional layout: VERSION|REQUEST_ID. The
        // handler reads the row, not these params; they exist so the action looks
        // like every other synthesized one.
        await actions.processAction('ATTEST', [1, candidate.request_id], data, null);
        // THE BIND SIGNAL. applyMirroredResponse sets STATUS 'valid' only
        // after the row verified; every skip path returns before it, leaving the
        // key unset. Stopping here is what makes the request bind exactly once:
        // a bound request must never see a second candidate, and each skip has
        // already logged its own reason inside the handler.
        if(data['STATUS'] === 'valid') break;
    }
}

// Binds the entry's mirror-admission capture ({ isMirrorAdmissionConsumerActive,
// isRowReadableAt }) into the two methods ../utility.js installs, non-enumerable, onto
// Utility.prototype. Each runs with `this` bound to the Utility instance, exactly as the class
// method it was, and keeps that method's parameter list.
module.exports = function createAttestMirror(deps){
    return {
        selectApplicableAttestationResponses(mirrorRows, requestRows, blockIndex, blockTime, network, coin){
            return selectApplicableAttestationResponses(this, deps, mirrorRows, requestRows,
                                                        blockIndex, blockTime, network, coin);
        },
        async processAttestationResponses(actions, db, block_index, block_time){
            return processAttestationResponses(this, deps, actions, db, block_index, block_time);
        }
    };
};
