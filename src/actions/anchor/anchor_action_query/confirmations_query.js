/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * getanchorconfirmations: the request validation and the paged row -> response
 * mapping for the per-TRANSACTION anchor read.
 *
 * Separate from action_query.js because it answers a different question off a
 * different key: "what did THIS transaction anchor, and how deep is it", which is the
 * only DOGE-side identity a mirrored anchor_reward_attestations row carries. It also
 * carries the only paging rules in this module (the truncation probe and the
 * action-boundary cut), which is the part of the read worth reading on its own.
 *
 ********************************************************************/

'use strict';

const { getLogger } = require('../../../observability/index.js');
// ANCHOR_ROW_LIMIT is the hard per-response row cap, shared with the SQL that fetches
// one row past it as a truncation probe; both live in src/db/anchor_sql.js.
const { ANCHOR_ROW_LIMIT } = require('../../../db/anchor_sql.js');
// The txid shape and the version normalizer are defined with the getanchoraction leg;
// sharing them keeps the two reads from drifting on either.
const { TXID_RE, normalizeVersion } = require('./action_query.js');

// ---------------------------------------------------------------------------
// getanchorconfirmations: DOGE anchor visibility for the BTC indexer.
//
// The BTC indexer mints the COLLECT-spendable anchor/archive reward from a
// hub-mirrored anchor_reward_attestations row, but ANCHOR lives on DOGE, so before
// this read the BTC side had NO way to check that the anchor it is paying for was ever
// mined: it took the mirror's word for it, and an evicted or reorged anchor still paid.
// This is the federation read that closes that (the third and last independent re-proof,
// after the publishing hub's and the receiving peer's).
//
// Keyed on the TXID ALONE, deliberately. The attestation row carries the reward tuple and
// doge_anchor_txid, not the wrapper checkpoint's DOGE-side identity, so getanchoraction's
// (block_index, checkpoint_seq) key is unusable here. Answering "what did THIS transaction
// anchor, and how deep is it" lets the caller do the binding itself: it compares the
// returned publisher / snapshot_block / seq against the tuple it is about to pay, and a
// txid that anchored something else fails that comparison instead of passing a weaker test.
//
// Every ANCHOR version is served: the SQL below filters none, so the caller can
// positively DETECT a version mismatch rather than see an empty answer for one and
// have to guess. The attestation-bearing versions are v0 and v1.
//
// BOUNDED AND PAGED, not merely bounded. The cap on the checkpoint-identity read above is
// justified by "the caller filters those by txid/version, so fetch the (tiny) candidate
// set"; that reasoning does NOT carry here. This read's caller (anchor_proof_client) binds
// a reward tuple, so a window that silently omits the one matching anchor is
// indistinguishable on the wire from a complete non-matching set, and the client turns
// that into a permanent 'rejected' - a legitimate COLLECT-spendable reward forfeited
// forever. So the row cap keeps a hard bound on any single response, ONE row past it is
// fetched purely as a truncation probe, and the response says both that it was cut off and
// where to resume.
//
// `after` is exclusive on action_index, which is NOT the row identity: anchor_actions keys on
// (action_index, section_index) and a v0 bundle writes one row per chain section under a
// single shared action_index (actions/anchor/index.js), so a page cut landing INSIDE a bundle would
// resume strictly past that action_index and drop the bundle's remaining sections forever -
// the same silent omission the cap exists to make visible, wearing the cursor's clothes. What
// makes the action_index cursor sound is therefore a boundary rule, not a uniqueness claim:
// buildAnchorConfirmationsResponse below never ends a truncated page inside an action, so
// every cut falls BETWEEN actions and the exclusive cursor still partitions the set with no
// gap and no overlap. section_index is selected and ordered so the within-action order is
// deterministic rather than whatever the engine returns, and so the caller can tell two
// anchors riding one transaction apart.

// Validate a getanchorconfirmations request: a single 64-hex txid, plus an optional
// exclusive page cursor. Returns {ok:true, txid, after} (txid lowercased, after a
// non-negative integer or null) or {ok:false, error}.
//
// The cursor is validated rather than coerced: a NaN / negative / fractional cursor
// silently coerced to 0 would restart the walk at the first page forever, which is the
// truncation bug wearing a different hat.
function validateAnchorConfirmationsParams({ txid, after_action_index }) {
    if (typeof txid !== 'string' || !TXID_RE.test(txid))
        return { ok: false, error: 'txid must be a 64-character hex string' };
    let after = null;
    if (after_action_index !== undefined && after_action_index !== null) {
        // Typed before it is numbered: a bare Number() call reads [] as 0 and true as 1, so
        // the two shapes most likely to arrive from a buggy caller would both validate.
        let n = (typeof after_action_index === 'number') ? after_action_index
              : (typeof after_action_index === 'string' && /^\d+$/.test(after_action_index)) ? Number(after_action_index)
              : NaN;
        if (!Number.isInteger(n) || n < 0)
            return { ok: false, error: 'after_action_index must be a non-negative integer' };
        after = n;
    }
    return { ok: true, txid: txid.toLowerCase(), after };
}

// One anchor row as the response serves it, lifted out of buildAnchorConfirmationsResponse
// so the paging rules and the per-row mapping each read on their own. `latestNum` is passed
// in rather than re-coerced here, so the depth math cannot disagree with the caller's.
function mapConfirmationRow(row, latestNum) {
    let dogeBlock = Number(row.block_index_doge);
    let confirmations = (Number.isFinite(latestNum) && Number.isFinite(dogeBlock) && latestNum >= dogeBlock)
        ? (latestNum - dogeBlock + 1) : 0;
    return {
        // Row identity, served so the caller can group a transaction's rows by the ACTION
        // they belong to. Without it two anchors riding one transaction are one flat list
        // and any per-bundle reconstruction the caller does silently spans both.
        action_index:       (row.action_index != null) ? Number(row.action_index) : null,
        section_index:      (row.section_index != null) ? Number(row.section_index) : null,
        status:             row.status,
        version:            normalizeVersion(row.version),
        checkpoint_chain:   row.chain,
        checkpoint_network: row.network,
        block_index:        (row.block_index != null) ? Number(row.block_index) : null,
        checkpoint_seq:     (row.checkpoint_seq != null) ? Number(row.checkpoint_seq) : null,
        snapshot_block:     (row.snapshot_block != null) ? Number(row.snapshot_block) : null,
        // The ELECTED PUBLISHER pubkey the reward is attested to. Null on the
        // unattested versions, which is itself the answer for a caller checking one.
        publisher:          row.publisher ? String(row.publisher).toLowerCase() : null,
        match_batch_seq:    (row.match_batch_seq != null) ? Number(row.match_batch_seq) : null,
        block_index_doge:   Number.isFinite(dogeBlock) ? dogeBlock : null,
        confirmations:      confirmations
    };
}

// Map the anchor rows a txid carries + the indexer's latest block into the
// getanchorconfirmations response.
//
// `confirmations` is DOGE-relative depth of the block the transaction landed in, computed
// exactly as buildAnchorActionResponse does (a missing row, a non-finite latest, or a row
// deeper than tip reports 0), so a caller can never read a shallow or rolled-back anchor as
// buried. One transaction can carry more than one anchor action (an archive head plus its
// own continuation), so `anchors` is a LIST and the caller picks by version rather than the
// read guessing for it. A decoded-invalid row is reported with its status rather than
// filtered out: "this txid exists and is invalid" is a positively-detected forge for the
// caller, while an empty list is merely "not seen", and the two must not collapse.
// `rows` is the ANCHOR_ROW_LIMIT + 1 the SQL above fetches. The extra row is a truncation
// PROBE and never reaches the caller: it is dropped here, and its existence is reported as
// `truncated` plus `next_after_action_index`, the exclusive cursor for the next page. A
// caller that ignores both sees exactly the response shape it saw before (the same first
// ANCHOR_ROW_LIMIT anchors in the same order), so the fields are additive; a caller that
// reads them can walk the whole set and stop guessing what fell off the end.
function buildAnchorConfirmationsResponse(config, latest, rows) {
    let coin    = config['COIN'];
    let network = config['NETWORK'];
    let latestNum = Number(latest);
    let all       = Array.isArray(rows) ? rows : [];
    let truncated = all.length > ANCHOR_ROW_LIMIT;
    let kept      = truncated ? all.slice(0, ANCHOR_ROW_LIMIT) : all;
    // NEVER END A TRUNCATED PAGE INSIDE AN ACTION. The cursor is exclusive on action_index,
    // but a row is (action_index, section_index): a v0 bundle carries one row per chain
    // section under one action_index, so a cut between two of those sections would hand back
    // a cursor the next page resumes strictly PAST, dropping the rest of that bundle from the
    // walk permanently. The caller cannot see the loss - a bundle missing its header-block
    // section reads as a complete non-matching set - and turns it into a memoized 'rejected',
    // forfeiting a COLLECT-spendable reward. So drop the trailing rows that share the probe
    // row's action_index and let the page end on the previous action. Pages become variable
    // length (<= ANCHOR_ROW_LIMIT, never more), which is why a caller must read `truncated`
    // and never infer completeness from the row count.
    if (truncated) {
        let probeAction = all[ANCHOR_ROW_LIMIT].action_index;
        if (probeAction != null) {
            let cut = kept.length;
            while (cut > 0 && String(kept[cut - 1].action_index) === String(probeAction)) cut--;
            // cut === 0 means one action holds more than ANCHOR_ROW_LIMIT section rows, so
            // trimming would emit an empty page whose cursor never advances - a walk that
            // never terminates is worse than the section loss it would be avoiding. Keep the
            // page as-is (today's behavior) and say so loudly: unreachable while a bundle
            // carries at most one section per ALLOWED_CHAINS, so reaching it means a limit or
            // a section-count assumption changed and this rule needs revisiting.
            if (cut === 0)
                getLogger().error('anchor confirmations: action_index ' + probeAction + ' spans more than ' +
                              ANCHOR_ROW_LIMIT + ' rows; cannot cut the page on an action boundary, ' +
                              'so its later sections are omitted from the walk');
            else
                kept = kept.slice(0, cut);
        }
    }
    let lastKept  = kept.length > 0 ? kept[kept.length - 1] : null;
    let nextAfter = (truncated && lastKept && lastKept.action_index != null)
                  ? Number(lastKept.action_index) : null;
    let list = kept.map(row => mapConfirmationRow(row, latestNum));
    return { coin, network, exists: list.length > 0, latest_block_index: latest, anchors: list,
             truncated: truncated, next_after_action_index: nextAfter };
}

module.exports = { validateAnchorConfirmationsParams, buildAnchorConfirmationsResponse };
