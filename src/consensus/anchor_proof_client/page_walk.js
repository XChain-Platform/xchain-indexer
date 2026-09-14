/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * The getanchorconfirmations page walk AnchorProofClient.proveMined runs
 * before it judges: every page of a txid's anchor rows, or nothing at all.
 *
 ********************************************************************/

'use strict';

const { getLogger } = require('../../observability/index.js');

// Hard stop on the getanchorconfirmations page walk in proveMined. At ANCHOR_ROW_LIMIT
// (20) rows a page this admits 500 anchor actions for one transaction, which no DOGE
// transaction can physically carry, so reaching it means the peer is faulty or hostile
// rather than that the bound is too small. It exists only so a peer that keeps answering
// "truncated" cannot spin the block loop; the walk answers 'unknown' there instead of
// judging an incomplete set.
const MAX_ANCHOR_PAGES = 25;

// WALK EVERY PAGE BEFORE JUDGING. getanchorconfirmations bounds its answer at
// ANCHOR_ROW_LIMIT rows, and a window that happens to hold some attested sibling
// anchor but not this tuple's own is, on the wire, identical to a complete
// non-matching set: judge (binding.js judgeAnchors) reads it as a positively-detected mis-bind and
// returns a MEMOIZED, permanent 'rejected', and anchor_reward_derive turns that
// into "no reward derived" forever. Degrading that case to 'unknown' instead is not
// the fix it looks like: 'unknown' throws AnchorProofUnavailableError, which halts
// block processing on every BTC node at once and never clears, since the same
// deterministic window comes back on every retry. So the window is removed rather
// than reinterpreted, and judge keeps seeing a COMPLETE anchor set.
//
// Only a peer that positively reports `truncated` is asked for another page. An
// indexer predating pagination reports nothing, the walk stops after one page, and
// this node behaves exactly as it did before, so a mixed fleet degrades to today's
// reading rather than to a stall.
//
// `client` is the AnchorProofClient; its fetch is what gets asked, so a caller that
// replaces fetch on the instance replaces it here too. Returns the complete anchor
// set, or null wherever proveMined must answer 'unknown'.
async function walkAnchorPages(client, txid){
    let anchors = [];
    let after   = null;
    let walking = true;
    for(let page = 0; walking && page < MAX_ANCHOR_PAGES; page++){
        let result = await client.fetch(txid, after);
        if(!result) return null;
        if(page === 0 && (!result.exists || result.anchors.length === 0)){
            // The DOGE indexer has no such transaction. That is NOT proof it will never
            // have one: it may simply be behind. Deferring is the only safe reading.
            return null;
        }
        anchors = anchors.concat(result.anchors);
        if(result.truncated !== true){ walking = false; break; }
        let next = Number(result.next_after_action_index);
        // A peer that says "truncated" and then cannot say where to resume, or hands
        // back a cursor that does not advance, is answering a protocol it only half
        // speaks. Judging the partial set it gave us is exactly the silent forfeit this
        // walk exists to remove, so treat it as the malformed reply it is.
        if(!Number.isInteger(next) || (after !== null && next <= after)){
            getLogger().warn('AnchorProofClient: ' + txid + ' reported truncated with an unusable ' +
                         'page cursor (' + result.next_after_action_index + '); cannot complete the walk');
            return null;
        }
        after = next;
    }
    if(walking){
        // MAX_ANCHOR_PAGES exhausted with the set still incomplete. Unreachable with a
        // real anchor transaction (the txid is the hub's own ANCHOR tx, and a DOGE
        // transaction cannot carry this many anchor actions), so this is a peer fault or
        // a hostile answer, not a bound to tune. Refuse to judge a partial set.
        getLogger().error('AnchorProofClient: ' + txid + ' still truncated after ' + MAX_ANCHOR_PAGES +
                      ' pages; refusing to judge a partial anchor set');
        return null;
    }
    return anchors;
}

module.exports = { walkAnchorPages, MAX_ANCHOR_PAGES };
