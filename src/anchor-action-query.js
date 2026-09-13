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
 * Pure helpers for the getanchoraction RPC (api.js) and its db read
 * (db.js getAnchorActionByCheckpoint), extracted for unit testing because
 * startApi() is not importable (it opens DB connections). The DB read itself
 * is exercised on regtest / integration; this module holds the request
 * validation, the checkpoint-version set, and the row -> response mapping
 * (including DOGE confirmation-depth math), which is the regression-worthy logic.
 *
 ********************************************************************/

'use strict';

// ARCHIVE_HEAD_VERSIONS is the archive-head version set, re-exported below for the
// callers that reason about versions. Its SQL fragment form is consumed only by the
// statements, so it is imported where they live.
const { ARCHIVE_HEAD_VERSIONS } = require('./stateHash.js');

// The anchor_actions STATEMENTS live in src/db/anchor_sql.js, beside the tables they
// name, and are re-exported below so every existing caller keeps importing them from
// here. They are constants rather than mixin methods because three layers run the
// identical text on three different connections: the db class, the RPC layer, and
// the recovery tool, which holds only a doQuery handle and no Database at all.
const {
    CHECKPOINT_VERSIONS, CHECKPOINT_SECTION_VERSIONS, CHECKPOINT_SECTION_VERSIONS_SQL,
    ANCHOR_ROW_LIMIT, ANCHOR_ACTIONS_SQL,
    ARCHIVE_HEAD_AUTHOR_SQL, ARCHIVE_CHUNK_SET_SQL, ARCHIVE_CHUNK_SET_BY_AUTHOR_SQL,
    ARCHIVE_HEAD_GATE_SQL,
    ARCHIVE_ANCHOR_ROW_LIMIT, ARCHIVE_ANCHOR_BY_CONTENT_SQL,
    ANCHOR_BY_TXID_COLUMNS, ANCHOR_BY_TXID_SQL, ANCHOR_BY_TXID_AFTER_SQL
} = require('./db/anchor_sql.js');

// A DOGE txid as the hub announces it (XANC_V0_DONE.txid / XANC_FINALIZED.txid).
const TXID_RE = /^[0-9a-fA-F]{64}$/;


// A batch CRC as the publisher formats it and anchor.js stores it: 8 lowercase
// hex digits (anchor.js normalizes BATCH_CRC32 with .toLowerCase() and rejects
// anything else at parse time, so the stored column is always this shape).
const ARCHIVE_CRC_RE = /^[0-9a-f]{8}$/;


// Dedupe an ARCHIVE_CHUNK_SET_SQL result to ONE row per chunk_index, lowest
// action_index first (the query's ORDER BY guarantees that arrival). Shared so the
// live path and recovery cannot drift on the tie-break either.
function dedupeArchiveChunks(rows) {
    let byIndex = new Map();
    for (let r of (rows || []))
        if (!byIndex.has(Number(r.chunk_index))) byIndex.set(Number(r.chunk_index), r);
    return Array.from(byIndex.values());
}

// Exact index-coverage completeness for a reassembled archive batch. Given the
// continuation-chunk rows (already deduped to one per index by dedupeArchiveChunks /
// getAnchorChunks) and the head's TOTAL_CHUNKS, returns the rows for indices
// 1..totalChunks-1 in ascending index order when the set covers that range EXACTLY,
// else null. Out-of-range indices (< 1 or >= totalChunks) are DROPPED rather than
// counted: a bare length test (chunks.length === totalChunks-1) both accepted a set
// missing a real in-range index but padded to length by a stray out-of-range orphan
// chunk (which then corrupts the reassembled byte order and the CRC verdict) and
// blocked a genuinely complete set that an extra stray chunk pushed over the count.
// With one row per in-range index and size === need, coverage of {1..need} is exact
// by pigeonhole. Shared verbatim by the head-side gate, the chunk-side gate, and
// recovery so the three reassembly paths cannot drift on completeness or byte order.
function archiveChunkCoverage(chunks, totalChunks) {
    let need = Number(totalChunks) - 1;
    if (!(need >= 1)) return null;
    let byIndex = new Map();
    for (let c of (chunks || [])) {
        let i = Number(c.chunk_index);
        if (i >= 1 && i <= need && !byIndex.has(i)) byIndex.set(i, c);
    }
    if (byIndex.size !== need) return null;
    let ordered = [];
    for (let i = 1; i <= need; i++) ordered.push(byIndex.get(i));
    return ordered;
}

// Validate the getanchoraction request shape. Returns
// {ok:true, block_index, checkpoint_seq, txid, version} on success (txid/version
// null when not supplied), or {ok:false, error} otherwise.
//
// `txid` and `version` are OPTIONAL narrowing filters added for the hub's
// anchor-gossip gate: without them this RPC answers "is THIS CHECKPOINT anchored
// at depth", which does not bind the specific announced transaction. With them it
// answers "did THIS txid (of THIS anchor version) land for this checkpoint",
// which is what closes XANC-ELECTED-FORGE-1 (a Byzantine ELECTED publisher
// announcing a real-but-different or never-mined txid).
function validateAnchorActionParams({ chain, network, block_index, checkpoint_seq, txid, version }) {
    if (typeof chain !== 'string' || !chain || typeof network !== 'string' || !network)
        return { ok: false, error: 'chain and network are required strings' };
    let bi = Number(block_index);
    let cs = Number(checkpoint_seq);
    if (!Number.isInteger(bi) || bi < 0 || !Number.isInteger(cs) || cs < 0)
        return { ok: false, error: 'block_index and checkpoint_seq must be non-negative integers' };
    let wantTxid = null;
    if (txid !== undefined && txid !== null && txid !== '') {
        if (typeof txid !== 'string' || !TXID_RE.test(txid))
            return { ok: false, error: 'txid must be a 64-character hex string' };
        wantTxid = txid.toLowerCase();
    }
    let wantVersion = null;
    if (version !== undefined && version !== null && version !== '') {
        let ver = Number(version);
        if (!Number.isInteger(ver) || !CHECKPOINT_VERSIONS.includes(ver))
            return { ok: false, error: 'version must be one of ' + CHECKPOINT_VERSIONS.join(', ') };
        wantVersion = ver;
    }
    return { ok: true, block_index: bi, checkpoint_seq: cs, txid: wantTxid, version: wantVersion };
}

// Pick the anchor row a caller asked for from the candidate set. `rows` must be
// ordered action_index DESC within a version family (ANCHOR_ACTIONS_SQL does this),
// so among rows of one family the highest action_index wins: a reorg-replayed
// re-anchor supersedes an earlier one. A supplied txid/version narrows to that exact
// anchor. Returns null when nothing matches.
//
// FAMILY BEFORE RECENCY. A checkpoint key can carry both a v0 bundle section and a
// v1 archive head (the archive wraps the same checkpoint), and the archive head
// usually lands at the higher action_index. getanchoraction is a per-SECTION reader:
// its unfiltered question is "is THIS checkpoint anchored", and answering it with the
// co-located archive head hands the caller a different transaction's txid and status
// while looking like a hit. So whenever any section row survives the caller's filters,
// the pick comes from the section family.
//
// The fallback is what keeps the archive leg reachable: with no section row among the
// candidates, the whole set is used, so an archive-only key still answers unfiltered,
// and an explicit `version: 1`/`version: 6` still resolves to that head even when a
// section shares the key. `txid` behaves the same way, since a txid that carries only
// an archive head leaves no section to prefer.
function selectAnchorRow(rows, filter) {
    let f = filter || {};
    let candidates = Array.isArray(rows) ? rows : [];
    if (f.version !== undefined && f.version !== null)
        candidates = candidates.filter(r => Number(r.version) === Number(f.version));
    if (f.txid)
        candidates = candidates.filter(r => String(r.txid || '').toLowerCase() === String(f.txid).toLowerCase());
    let sections = candidates.filter(r => CHECKPOINT_SECTION_VERSIONS.includes(Number(r.version)));
    if (sections.length > 0) candidates = sections;
    return candidates.length > 0 ? candidates[0] : null;
}

// Map an anchor_actions row (or null) + the indexer's latest block into the RPC response.
// `config` is the indexer config (COIN/NETWORK = the anchor chain this indexer serves,
// i.e. DOGE). Confirmations are DOGE-relative depth of the block the ANCHOR landed in;
// a missing row, a non-finite latest, or a row deeper than tip (rolled back) reports 0
// so a caller never treats a shallow/negative-depth anchor as confirmed.
// `extra.checkpoint_anchored` tells a caller that used a txid/version filter
// whether ANY anchor exists for the checkpoint identity, so it can tell a benign
// "not anchored yet" (abstain) apart from a positively-detected forge: the
// checkpoint IS anchored, but not by the txid that was announced. Defaults to
// !!row, which keeps a filterless caller's response semantics unchanged.
// Coerce a stored version column to a number, normalizing null/undefined/NaN
// to null so a missing version never surfaces as NaN in the response.
function normalizeVersion(v) {
    if (v === null || v === undefined) return null;
    let n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function buildAnchorActionResponse(config, latest, row, extra) {
    let coin    = config['COIN'];
    let network = config['NETWORK'];
    let anchored = (extra && extra.checkpoint_anchored !== undefined) ? !!extra.checkpoint_anchored : !!row;
    if (!row) {
        return { coin, network, exists: false, checkpoint_anchored: anchored,
                 latest_block_index: latest, confirmations: 0 };
    }
    let latestNum = Number(latest);
    let dogeBlock = Number(row.block_index_doge);
    let confirmations = (Number.isFinite(latestNum) && Number.isFinite(dogeBlock) && latestNum >= dogeBlock)
        ? (latestNum - dogeBlock + 1) : 0;
    return {
        coin, network,
        exists:             true,
        checkpoint_anchored: anchored,
        status:             row.status,                    // 'valid' | 'unverified' | 'invalid: ...'
        version:            Number(row.version),
        // DOGE txid this anchor landed in. null when the tx linkage is missing;
        // a hub binding the announced txid MUST treat null as unverifiable.
        txid:               row.txid ? String(row.txid).toLowerCase() : null,
        checkpoint_chain:   row.chain,
        checkpoint_network: row.network,
        block_index:        Number(row.block_index),
        block_hash:         row.block_hash,
        ledger_hash:        row.ledger_hash,
        actions_hash:       row.actions_hash,
        contract_hash:      row.contract_hash,
        checkpoint_seq:     Number(row.checkpoint_seq),
        snapshot_block:     (row.snapshot_block != null) ? Number(row.snapshot_block) : null,
        state_root:           row.state_root || null,
        state_root_version:   row.state_root ? normalizeVersion(row.state_root_version) : null,
        block_merkle_root:    row.block_merkle_root || null,
        block_merkle_version: row.block_merkle_root ? normalizeVersion(row.block_merkle_version) : null,
        block_index_doge:   dogeBlock,
        latest_block_index: latest,
        confirmations:      confirmations
    };
}

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
// single shared action_index (actions/anchor.js), so a page cut landing INSIDE a bundle would
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
                console.error('anchor confirmations: action_index ' + probeAction + ' spans more than ' +
                              ANCHOR_ROW_LIMIT + ' rows; cannot cut the page on an action boundary, ' +
                              'so its later sections are omitted from the walk');
            else
                kept = kept.slice(0, cut);
        }
    }
    let lastKept  = kept.length > 0 ? kept[kept.length - 1] : null;
    let nextAfter = (truncated && lastKept && lastKept.action_index != null)
                  ? Number(lastKept.action_index) : null;
    let list = kept.map(row => {
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
    });
    return { coin, network, exists: list.length > 0, latest_block_index: latest, anchors: list,
             truncated: truncated, next_after_action_index: nextAfter };
}

// Validate a getarchiveanchor request. Returns
// {ok:true, block_index, checkpoint_seq, batch_crc32, match_count, author} or
// {ok:false, error}.
//
// batch_crc32 and match_count are REQUIRED, not optional narrowing filters: without
// both, the query degenerates into "is this checkpoint archived at all", which is
// true for a DIFFERENT batch wrapped in the same checkpoint and would tell a hub its
// unpublished archive is already on-chain. That direction loses match rows
// permanently, so the content terms are part of the question, never a refinement of it.
//
// `author` is optional and, when supplied, scopes the answer to "did THIS publisher
// address already publish this batch". The hub always supplies its own DOGE address:
// unscoped, a third party who copied our already-mined head onto the chain (or a
// co-signer who front-ran it) would answer "already published" for a batch whose
// CHUNKS that party never sent, and the hub would skip its own head and strand the
// archive. Scoping makes the check answer only for spends this publisher made.
function validateArchiveAnchorParams({ chain, network, block_index, checkpoint_seq, batch_crc32, match_count, author }) {
    if (typeof chain !== 'string' || !chain || typeof network !== 'string' || !network)
        return { ok: false, error: 'chain and network are required strings' };
    let bi = Number(block_index);
    let cs = Number(checkpoint_seq);
    if (!Number.isInteger(bi) || bi < 0 || !Number.isInteger(cs) || cs < 0)
        return { ok: false, error: 'block_index and checkpoint_seq must be non-negative integers' };
    if (typeof batch_crc32 !== 'string' || !ARCHIVE_CRC_RE.test(batch_crc32.toLowerCase()))
        return { ok: false, error: 'batch_crc32 must be an 8-character hex string' };
    let mc = Number(match_count);
    if (!Number.isInteger(mc) || mc < 0)
        return { ok: false, error: 'match_count must be a non-negative integer' };
    let wantAuthor = null;
    if (author !== undefined && author !== null && author !== '') {
        if (typeof author !== 'string') return { ok: false, error: 'author must be a string address' };
        wantAuthor = author;
    }
    return { ok: true, block_index: bi, checkpoint_seq: cs,
             batch_crc32: batch_crc32.toLowerCase(), match_count: mc, author: wantAuthor };
}

// Pick the archive head a caller asked for from an ARCHIVE_ANCHOR_BY_CONTENT_SQL
// result. Rows arrive action_index ASC, so with no author filter the EARLIEST head
// wins, the same canonical-head rule getAnchorV1ByBatchSeq and ARCHIVE_HEAD_AUTHOR_SQL
// use (a later copy of a batch never supersedes the row that first published it).
// A supplied author narrows to that publisher's own head; a row whose author could
// not be resolved (source null) compares unequal and is skipped, which is fail-closed
// (the caller sees "absent" and publishes, rather than adopting a head it cannot
// attribute). Address comparison is exact, not case-folded: base58/bech32 addresses
// are case-significant in the first form and canonically lowercase in the second, so
// folding could equate two different addresses.
function selectArchiveHeadRow(rows, filter) {
    let f = filter || {};
    let candidates = Array.isArray(rows) ? rows : [];
    if (f.author) candidates = candidates.filter(r => r.source != null && String(r.source) === String(f.author));
    return candidates.length > 0 ? candidates[0] : null;
}

// The continuation-chunk indexes present for a head, as a sorted array. `chunkRows`
// is a deduped ARCHIVE_CHUNK_SET_BY_AUTHOR_SQL result (v2 rows only; chunk 0 rides in
// the head itself, so it is reported present whenever the head is).
function presentChunkIndexes(head, chunkRows) {
    let present = new Set([0]);
    for (let r of (chunkRows || [])) {
        let i = Number(r.chunk_index);
        if (Number.isInteger(i) && i > 0) present.add(i);
    }
    return Array.from(present).sort((a, b) => a - b);
}

// Map a content-addressed head row (or null) plus its chunk set into the RPC response.
// Confirmations are DOGE-relative depth, computed exactly as buildAnchorActionResponse
// does, so the two anchor reads cannot drift on the "deeper than tip / not finite"
// edges.
//
// `chunks_present` and `chunks_complete` exist so the hub can resume a PARTIALLY
// published archive: the head landing and the continuation chunks landing are separate
// broadcasts, and a crash between them leaves a head on-chain with chunks missing.
// Without per-chunk resolution the hub could only choose between re-sending every
// chunk (paying again for the ones that landed) and skipping the batch (stranding it).
function buildArchiveAnchorResponse(config, latest, head, chunkRows) {
    let coin    = config['COIN'];
    let network = config['NETWORK'];
    if (!head) {
        return { coin, network, exists: false, latest_block_index: latest, confirmations: 0,
                 chunks_present: [], chunks_complete: false };
    }
    let latestNum = Number(latest);
    let dogeBlock = Number(head.block_index_doge);
    let confirmations = (Number.isFinite(latestNum) && Number.isFinite(dogeBlock) && latestNum >= dogeBlock)
        ? (latestNum - dogeBlock + 1) : 0;
    let total   = Number(head.total_chunks);
    let present = presentChunkIndexes(head, chunkRows);
    // Complete only when EVERY declared index is accounted for. A non-finite /
    // non-positive total_chunks (a malformed head) can never be complete.
    let complete = Number.isInteger(total) && total > 0 && present.length >= total &&
                   present[present.length - 1] === total - 1;
    return {
        coin, network,
        exists:             true,
        status:             head.status,                   // 'valid' | 'unverified' | 'invalid: ...'
        version:            Number(head.version),
        txid:               head.txid ? String(head.txid).toLowerCase() : null,
        // The publishing address this head is attributed to; null when the action
        // linkage is missing. A caller that supplied `author` already knows it matches.
        author:             head.source != null ? String(head.source) : null,
        checkpoint_chain:   head.chain,
        checkpoint_network: head.network,
        block_index:        Number(head.block_index),
        checkpoint_seq:     Number(head.checkpoint_seq),
        snapshot_block:     (head.snapshot_block != null) ? Number(head.snapshot_block) : null,
        // The seq the batch actually landed under, which is exactly what the caller
        // could not know: it is how a resuming publisher addresses the chunk slots of
        // a batch its own process allocated a different seq for.
        match_batch_seq:    (head.match_batch_seq != null) ? Number(head.match_batch_seq) : null,
        match_count:        (head.match_count != null) ? Number(head.match_count) : null,
        batch_crc32:        head.batch_crc32 != null ? String(head.batch_crc32).toLowerCase() : null,
        total_chunks:       Number.isFinite(total) ? total : null,
        chunks_present:     present,
        chunks_complete:    complete,
        block_index_doge:   dogeBlock,
        latest_block_index: latest,
        confirmations:      confirmations
    };
}

module.exports = {
    CHECKPOINT_VERSIONS, CHECKPOINT_SECTION_VERSIONS, CHECKPOINT_SECTION_VERSIONS_SQL,
    ANCHOR_ROW_LIMIT, ANCHOR_ACTIONS_SQL,
    ARCHIVE_HEAD_AUTHOR_SQL, ARCHIVE_CHUNK_SET_SQL, ARCHIVE_CHUNK_SET_BY_AUTHOR_SQL,
    ARCHIVE_HEAD_GATE_SQL, dedupeArchiveChunks, archiveChunkCoverage,
    ARCHIVE_HEAD_VERSIONS, ARCHIVE_CRC_RE, ARCHIVE_ANCHOR_ROW_LIMIT,
    ARCHIVE_ANCHOR_BY_CONTENT_SQL, validateArchiveAnchorParams, selectArchiveHeadRow,
    presentChunkIndexes, buildArchiveAnchorResponse,
    validateAnchorActionParams, selectAnchorRow, buildAnchorActionResponse,
    ANCHOR_BY_TXID_SQL, ANCHOR_BY_TXID_AFTER_SQL,
    validateAnchorConfirmationsParams, buildAnchorConfirmationsResponse
};
