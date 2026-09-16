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
 * XChain Indexer - Utility: ATTEST response-mirror binding rule
 *
 * The pure rule that decides which hub-mirrored ATTEST responses bind at a block, and in
 * what order. Plain functions, not methods: attest_mirror.js installs the rule onto
 * Utility.prototype, bound to the entry's mirror-admission capture, which every function
 * here that needs it takes as its `deps` argument.
 *
 ********************************************************************/

'use strict';

// The ATTEST response-mirror flag day, read from the LOCAL v0 request row. Same
// module attest.js's isMirrorEraRequest seam reads, so the applier pass and the
// handler can never disagree about which era a request is in.
const attestResponseMirror = require('../attest_response_mirror_activation.js');
// The zero-confirmation flag day, also read from the LOCAL v0 request row. Change C
// of that height is this file's: above it the applier falls through an inert
// candidate row to the next one instead of stranding the request until its deadline.
const attestZeroConf = require('../attest_zero_conf_activation.js');
// Both flag days are required here rather than taken from the entry: nothing purges them
// together with utility.js, so the require cache hands this part the very objects the entry
// would hold. The mirror-admission map is the one a suite purges, and it comes from the entry.
//
// The per-block cap on mirror applies. actions/attest/index.js sets its static
// ATTEST_MAX_MIRROR_APPLIES_PER_BLOCK from this same constants module, so this is the number
// the handler declares. Read here, at the top of the file, from the leaf module rather than
// from the ATTEST handler in the middle of a block: the action modules are constructed from
// the Utility class, and requiring the handler would pull that layer into this part, while
// actions/attest/constants.js requires nothing. The XCALL pass reads its own per-block cap
// the same way.
const { ATTEST_MAX_MIRROR_APPLIES_PER_BLOCK } = require('../actions/attest/constants.js');

// The ATTEST response-mirror binding rule, as a pure function: which mirrored
// responses BIND at block B, and in what order.
//
// It is a function rather than SQL because the mirror may be a separate database
// connection (db.getMirroredAttestationResponses), so the two halves of the join
// cannot meet in one statement, and because this predicate is the consensus rule
// the whole design rests on: every node must fire a contract callback at the SAME
// block, and the block is
//
//     R binds at B  <=>  R.effective_time <= t(B)
//                        and B <= request.deadline_block
//                        and the LOCAL v0 row for R.request_id is 'pending'
//                        and that row is mirror-era (activation height)
//
// and nothing else. There is deliberately no grace term: a grace is a node-local
// WAIT (the barrier in XChainIndexer/hub_db_sync), never a term in a hashed
// predicate, or a node that waited longer would bind at a different block.
// `blockTime` is PROTOCOL time (MTP off mainnet), which every node derives
// identically from the chain, and effective_time is inside the SIGNED canonical,
// so both sides of the comparison are chain- or signature-derived.
//
// A row whose first satisfying block is past the deadline never binds (the
// `B <= deadline_block` clause), the expiry sweep flips the request to 'expired'
// at deadline+1, and the expired callback stands. A row satisfied exactly AT
// the deadline block binds: the sweep's own predicate is deadline_block < B.
//
// ORDER is the local request row's (block_index, action_index), never the mirror
// row's informational copies of them and never a CHAR(64) request_id collation.
// Insertion order of the mirror rows is discarded here.
//
// CAPPED at ATTEST_MAX_MIRROR_APPLIES_PER_BLOCK, taken as a PREFIX of that order, so a
// block's callback cost is bounded and every node defers the same rows. The order is
// TOTAL (action_index is unique), which is the whole reason a prefix is safe: over a
// partial or planner-dependent order two nodes would take different subsets and fork.
// A deferred row needs no bookkeeping, because it is still applicable at the next
// block and this same call selects it there; the constant's own comment carries the
// carry-forward rule in full.
//
// ABOVE THE ZERO-CONF HEIGHT (keyed per request on
// the request's OWN block) the item additionally carries `candidates`: every
// eligible mirror row for that request, sorted (effective_time ASC, response_hash
// ASC), with `response` the head of that list. The read has no ORDER BY of its own,
// so this sort is the only order there is. It is still ONE item per request
// and the cap still counts requests; the difference is that the applier can try
// the second row when the first turns out to be inert, instead of re-selecting the
// same inert row every block until the deadline. Below the height the item is the
// single choice above and carries no `candidates` key at all, so a mixed fleet
// agrees byte for byte on every request below it.
//
// ABOVE THE MIRROR-ADMISSION CONSUMER ACTIVATION for (coin, network) at B, the first
// clause is re-keyed: a row binds when its signed admission
// height for this chain is at or below B, and a row with NO admission height binds by
// effective_time <= t(B) exactly as today, at every height. Attest responses
// are read by BTC alone (the call-site guard in XChainIndexer), so the one column the hub
// stamps and this reads is admit_block_btc. Everything else in the predicate, the deadline
// clause, the pending and mirror-era clauses, the tie-break, the total order and the cap,
// is untouched by the flag day. `coin` defaults to this indexer's own, so the existing
// five-argument callers keep their meaning.
function selectApplicableAttestationResponses(util, deps, mirrorRows, requestRows, blockIndex, blockTime, network, coin){
    const { isMirrorAdmissionConsumerActive } = deps;
    let block = Number(blockIndex);
    let time  = Number(blockTime);
    let chain = (coin === undefined) ? (util.config && util.config['COIN']) : coin;
    // Keyed on B as handed in, never on the coerced `block`: Number(null) is 0, and 0 is
    // above an activation armed at height 0.
    let admission = isMirrorAdmissionConsumerActive(chain, network, blockIndex);
    let { byId, fallThroughIds } = pendingMirrorRequests(requestRows, block, network);
    if(byId.size === 0) return [];

    let { chosen, candidatesById } = chooseMirrorRows(deps, mirrorRows, byId, fallThroughIds,
                                                      admission, blockIndex, blockTime, time);
    orderFallThroughCandidates(chosen, candidatesById);
    if(chosen.size === 0) return [];

    return cappedApplicableItems(chosen, byId, candidatesById);
}

// Local request rows, keyed for lookup. Filtered to the ones a mirror row may
// bind to at all, which is the same set the SQL bound selects; re-stated here
// because THIS is the copy of the rule that is tested and falsified.
//
// fallThroughIds: ids whose request sits above the zero-conf height, so their item carries the
// full candidate list. Kept beside byId rather than stamped onto the request row
// because that row is handed to the handler as data['MIRROR_REQUEST'] and must
// stay the row the local read returned.
function pendingMirrorRequests(requestRows, block, network){
    let byId = new Map();
    let fallThroughIds = new Set();
    for(let req of (requestRows || [])){
        if(String(req.request_status) !== 'pending')                    continue;
        if(!(block <= Number(req.deadline_block)))                      continue;
        // The flag day is keyed on the REQUEST's own block, read from the
        // local row. attest.js's isMirrorEraRequest is the same module: the applier
        // re-checks it as its own gate, and the chain-side gate calls it too.
        if(!attestResponseMirror.isResponseMirrorActive(req.block_index, network)) continue;
        let reqId = String(req.request_id).toLowerCase();
        byId.set(reqId, req);
        // Evaluated HERE, beside the mirror-era check and off the same field:
        // both eras are properties of the request, never of the applying block, so a
        // node that catches up late reaches the same verdict for the same request.
        if(attestZeroConf.isZeroConfActive(req.block_index, network)) fallThroughIds.add(reqId);
    }
    return { byId, fallThroughIds };
}

// One response per request, chosen from however many honest rows the mirror
// holds for it. The mirror's key is (network, request_id, effective_time) because
// a round that finalized under two leader slots (the slot follows the chain tip
// each hub polled) yields two quorum-signed rows differing only in the stamp,
// and every hub ends up holding both. The smaller effective_time binds, ties
// broken by response_hash, both signed fields, so every node picks the same one
// and the other is skipped rather than applied second.
function chooseMirrorRows(deps, mirrorRows, byId, fallThroughIds, admission, blockIndex, blockTime, time){
    const { isRowReadableAt } = deps;
    let chosen = new Map();
    // id -> every eligible row for that request, above the height only.
    let candidatesById = new Map();
    for(let row of (mirrorRows || [])){
        let id = String(row.request_id || '').toLowerCase();
        if(!byId.has(id))                          continue;
        if(admission){
            // The readable-at-B rule: admit_block_btc <= B, or the legacy clock rule
            // for a row that carries no admission height. Both signed by the quorum.
            if(!isRowReadableAt(row.admit_block_btc, blockIndex, row.effective_time, blockTime)) continue;
        } else {
            if(!(Number(row.effective_time) <= time))  continue;
        }
        if(fallThroughIds.has(id)){
            // Above the height nothing is discarded here: the loser of the tie-break
            // is the FALL-THROUGH candidate, and discarding it would strand the request on
            // an inert row. The head is picked by the sort below, not by this pass.
            let list = candidatesById.get(id);
            if(!list) candidatesById.set(id, list = []);
            list.push(row);
            continue;
        }
        let prior = chosen.get(id);
        if(prior){
            let a = Number(row.effective_time), b = Number(prior.effective_time);
            let better = (a < b) || (a === b &&
                String(row.response_hash || '') < String(prior.response_hash || ''));
            if(!better) continue;
        }
        chosen.set(id, row);
    }
    return { chosen, candidatesById };
}

// The same (effective_time, response_hash) rule the tie-break above applies, as an
// ORDER instead of a choice: the head is what binds first, and the tail is what the
// applier tries next. Both keys are signed fields, so every node builds the same
// sequence; equal on both keys means two copies of one signed response, and the
// sort is stable, so even that is ordered identically everywhere.
function orderFallThroughCandidates(chosen, candidatesById){
    for(let [id, list] of candidatesById){
        list.sort((x, y) => {
            let a = Number(x.effective_time), b = Number(y.effective_time);
            if(a !== b) return a - b;
            let hx = String(x.response_hash || ''), hy = String(y.response_hash || '');
            return hx < hy ? -1 : (hx > hy ? 1 : 0);
        });
        chosen.set(id, list[0]);
    }
}

// The chosen rows as applicable items in the binding order, the local request row's
// (block_index, action_index), cut to the per-block cap as a PREFIX of that order.
function cappedApplicableItems(chosen, byId, candidatesById){
    let out = [];
    for(let [id, row] of chosen){
        let item = { response: row, request: byId.get(id) };
        // Present only above the height, so the below-height item shape is untouched.
        let list = candidatesById.get(id);
        if(list) item.candidates = list;
        out.push(item);
    }
    out.sort((x, y) => {
        let bx = Number(x.request.block_index),  by = Number(y.request.block_index);
        if(bx !== by) return bx - by;
        let ax = Number(x.request.action_index), ay = Number(y.request.action_index);
        return ax - ay;
    });
    return out.slice(0, ATTEST_MAX_MIRROR_APPLIES_PER_BLOCK);
}

module.exports = { selectApplicableAttestationResponses };
