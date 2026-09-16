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
 * getarchiveanchor: the content-addressed archive-head read, plus the chunk-set
 * helpers the head, the chunk gate and recovery all share.
 *
 * Its own file because it is keyed on a batch's CONTENT (crc32 + match_count, and
 * optionally the publishing address) rather than on a checkpoint or a transaction, and
 * because the reassembly helpers below are consumed by three separate paths (the
 * head-side gate, the chunk-side gate and bin/recovery.js) that must not drift on
 * completeness or byte order.
 *
 ********************************************************************/

'use strict';

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
    ARCHIVE_CRC_RE, dedupeArchiveChunks, archiveChunkCoverage,
    validateArchiveAnchorParams, selectArchiveHeadRow, presentChunkIndexes,
    buildArchiveAnchorResponse
};
