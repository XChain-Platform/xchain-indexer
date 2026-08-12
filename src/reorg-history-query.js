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
 * Pure helpers for the getreorghistory RPC (api.js), extracted for unit testing
 * because startApi() is not importable (it opens DB connections). Mirrors the
 * anchor-action-query.js layout: request validation, the SQL, and the row ->
 * response mapping.
 *
 * WHY THIS EXISTS (REORG-OLDHASH-UNVERIFIED-1):
 * xchain-hub's ReorgHandler currently accepts a peer's reorg announcement after
 * confirming only that the announced NEW hash is what its own node serves at the
 * reorg height. It never confirms the announced OLD hash was ever canonical there,
 * so a single Byzantine validator can announce a fabricated oldHash and drive a
 * fake-reorg rollback. The decoder already records the truth: every REORG event
 * stores the ORPHANED blocks as [{block_index, block_hash}]. The indexer's
 * getReorgsSince() throws the hashes away (it only needs the deepest block_index),
 * so nothing surfaces them. This RPC does.
 *
 * Reads the DECODER database (events is a decoder table), not the indexer DB.
 *
 ********************************************************************/

'use strict';

// A block hash as the decoder records it.
const BLOCK_HASH_RE = /^[0-9a-fA-F]{64}$/;

// Reorgs are rare; a hub asking "was this hash orphaned at this height" needs a
// handful of recent events, not the chain's whole history. Bounded so a peer can
// never make an indexer serialize an unbounded events scan.
const DEFAULT_LIMIT = 100;
const MAX_LIMIT     = 1000;

// Newest-first so a caller checking a RECENT reorg reads the relevant rows before
// the limit truncates. `id` is the decoder's monotonic events id.
const REORG_EVENTS_SQL =
    `SELECT id, data FROM events WHERE code = 'REORG' AND id > ? ORDER BY id DESC LIMIT ?`;

// Validate the getreorghistory request shape. Every param is optional.
//   since_id     - only events with a higher decoder events id
//   block_index  - only reorgs that orphaned a block at this exact height
//   block_hash   - only reorgs that orphaned this exact block hash
//   limit        - bounded page size
// Returns {ok:true, since_id, block_index, block_hash, limit} or {ok:false, error}.
function validateReorgHistoryParams({ since_id, block_index, block_hash, limit } = {}) {
    let sinceId = 0;
    if (since_id !== undefined && since_id !== null && since_id !== '') {
        let s = Number(since_id);
        if (!Number.isInteger(s) || s < 0) return { ok: false, error: 'since_id must be a non-negative integer' };
        sinceId = s;
    }
    let blockIndex = null;
    if (block_index !== undefined && block_index !== null && block_index !== '') {
        let bi = Number(block_index);
        if (!Number.isInteger(bi) || bi < 0) return { ok: false, error: 'block_index must be a non-negative integer' };
        blockIndex = bi;
    }
    let blockHash = null;
    if (block_hash !== undefined && block_hash !== null && block_hash !== '') {
        if (typeof block_hash !== 'string' || !BLOCK_HASH_RE.test(block_hash))
            return { ok: false, error: 'block_hash must be a 64-character hex string' };
        blockHash = block_hash.toLowerCase();
    }
    let lim = DEFAULT_LIMIT;
    if (limit !== undefined && limit !== null && limit !== '') {
        let l = Number(limit);
        if (!Number.isInteger(l) || l < 1) return { ok: false, error: 'limit must be a positive integer' };
        lim = Math.min(l, MAX_LIMIT);
    }
    return { ok: true, since_id: sinceId, block_index: blockIndex, block_hash: blockHash, limit: lim };
}

// Decode one decoder REORG event row into its orphaned blocks. The decoder writes
// `data` as a JSON array; historical rows may hold bare numeric block indexes
// instead of {block_index, block_hash} objects, in which case the hash is unknown
// (null) rather than absent, so a caller can tell "no hash recorded" apart from
// "hash did not match". A row whose data will not parse yields no blocks rather
// than throwing: one corrupt event must not fail the whole read.
function parseReorgEvent(row) {
    let blocks = [];
    try {
        let data = JSON.parse(row.data);
        if (Array.isArray(data)) {
            for (let block of data) {
                if (block !== null && typeof block === 'object') {
                    blocks.push({
                        block_index: Number(block.block_index),
                        block_hash:  block.block_hash ? String(block.block_hash).toLowerCase() : null
                    });
                } else {
                    blocks.push({ block_index: Number(block), block_hash: null });
                }
            }
        }
    } catch (e) { /* corrupt event: no blocks */ }
    blocks = blocks.filter(b => Number.isFinite(b.block_index));
    let minBlockIndex = blocks.length > 0 ? Math.min(...blocks.map(b => b.block_index)) : null;
    return { id: Number(row.id), blocks, min_block_index: minBlockIndex };
}

// Map decoder events rows into the RPC response, applying the optional
// block_index / block_hash narrowing. An event matches when ANY orphaned block in
// it matches every supplied filter: that is exactly the question the hub asks
// ("did you orphan block_hash H at height N?"), so a match is positive evidence
// that H was canonical-then-orphaned there.
// `opts.decoderReorgHalted` is threaded from a live isReorgHalted() probe at the call
// site and surfaced as an ADDITIVE trailing field on the response: a decoder that wrote a durable
// REORG_HALT marker cannot advance, so a hub reading this history must be able to tell "no recent
// reorgs" apart from "decoder halted, history frozen". Existing fields are unchanged/unreordered.
function buildReorgHistoryResponse(rows, filter, opts) {
    let f = filter || {};
    let events = (Array.isArray(rows) ? rows : []).map(parseReorgEvent);
    if (f.block_index !== undefined && f.block_index !== null)
        events = events.filter(e => e.blocks.some(b => b.block_index === Number(f.block_index)));
    if (f.block_hash)
        events = events.filter(e => e.blocks.some(b => b.block_hash === String(f.block_hash).toLowerCase()));
    // When BOTH are supplied the pair must occur on the SAME orphaned block, not on
    // two different blocks of the same event. Filtering them independently above
    // would let a reorg that orphaned (N, H1) and (N+1, H2) answer yes to (N, H2).
    if (f.block_index !== undefined && f.block_index !== null && f.block_hash)
        events = events.filter(e => e.blocks.some(b =>
            b.block_index === Number(f.block_index) && b.block_hash === String(f.block_hash).toLowerCase()));
    return {
        events,
        count:    events.length,
        latest_id: events.length > 0 ? Math.max(...events.map(e => e.id)) : null,
        // True only when a filter was supplied AND an orphaned block matched it.
        // The hub reads this as "oldHash was canonical, then orphaned, at that height".
        matched:  ((f.block_index !== undefined && f.block_index !== null) || !!f.block_hash) && events.length > 0,
        // Additive trailing field: true when the decoder has a durable REORG_HALT marker.
        decoderReorgHalted: !!(opts && opts.decoderReorgHalted)
    };
}

module.exports = {
    BLOCK_HASH_RE, DEFAULT_LIMIT, MAX_LIMIT, REORG_EVENTS_SQL,
    validateReorgHistoryParams, parseReorgEvent, buildReorgHistoryResponse
};
