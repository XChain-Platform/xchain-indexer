/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC, https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available; contact
 * legal@dankest.llc.
 *
 **********************************************************************
 *
 * ATTEST batch wire - constants, failure reasons, field shapes
 *
 * A part of ../attest_batch_wire.js, the ATTEST v5/v6 batch wire. It is
 * byte-identical in both repos like the entry (xchain-hub src/lib/attest_batch_wire/,
 * xchain-indexer src/actions/attest/attest_batch_wire/), so it requires only node
 * stdlib and its sibling parts, never a path outside this directory.
 *
 * Every number here is consensus: the caps bound what a node may be made to parse
 * or inflate, and the failure strings reach the chain inside a recorded status.
 *
 ********************************************************************/

'use strict';

/** Wire version carrying the batch head. @type {number} */
const ATTEST_BATCH_HEAD_VERSION = 5;

/** Wire version carrying a batch continuation chunk. @type {number} */
const ATTEST_BATCH_CONTINUATION_VERSION = 6;

/**
 * Whole-action wire ceiling in bytes: the encoder's MAX_ACTION_DATA_LENGTH
 * (8192) minus OP_RETURN_PUSH_OVERHEAD (3). LOCAL COPY, pinned by test rather
 * than by require, because the hub twin cannot reach across the repo boundary.
 * The budget covers the ENTIRE action string, `ATTEST|5|` prefix included.
 * @type {number}
 */
const ATTEST_BATCH_WIRE_MAX_BYTES = 8189;

/**
 * Consensus ceiling on the inflated batch body. Deliberately the batch's own
 * number and not PRICE's 8189, which bounds a batch that must ride ONE wire:
 * this batch is chunked, so its bound is the memory a node may be made to spend
 * inflating it. The admission cap is 10 requests per block, about 60 per hour at
 * the Bitcoin cadence, and at the 8189-byte body cap that is roughly 530 KB of
 * worst-case window, so 1 MiB leaves about two times headroom.
 * @type {number}
 */
const ATTEST_BATCH_MAX_INFLATED_BYTES = 1048576;

/**
 * Consensus ceiling on rows per batch. Attacker-supplied counts drive parse
 * loops on every indexing node, so the bound is resolved before the loop that
 * consumes it. 256 is the PRICE_BATCH_MAX_ROUND_COUNT reasoning applied here.
 * @type {number}
 */
const ATTEST_BATCH_MAX_ROWS = 256;

/**
 * Consensus ceiling on chunks per batch, bounding TOTAL_CHUNKS on both wires.
 *
 * TOTAL_CHUNKS is attacker-supplied and lands in an INT UNSIGNED column
 * (`attests.batch_total_chunks`), so unbounded it wedges the node rather than
 * failing the wire: a head declaring 4294967296 parses, actions/attest/index.js stamps
 * it through unchanged, and the INSERT throws inside the block transaction under
 * the MariaDB default sql_mode. That is a halt any sender can arm for the price
 * of one transaction.
 *
 * The bound also has to be one the READER can serve, because a chunk set the
 * reader cannot return whole is a batch that never absorbs: db.getAttestBatchChunks
 * bounds its author-scoped read at this same number, and one publisher's valid rows
 * under one key are their head plus at most one row per slot.
 *
 * 256 is the DEPLOY chunked-wire rule (MAX_DEPLOY_CHUNKS) applied here, and it is
 * sized off the ENCODER rather than guessed: the largest body encodeAttestBatch
 * will emit is ATTEST_BATCH_MAX_INFLATED_BYTES of incompressible bytes, which
 * deflate-raw plus base64 turns into 1398536 characters, and a continuation carries
 * 8098 of them, so the encoder cannot exceed 174 chunks. Nothing this codebase can
 * build is refused here.
 * @type {number}
 */
const ATTEST_BATCH_MAX_CHUNKS = 256;

/**
 * Consensus inflate-ratio cap, matching the platform's other compressed wires so
 * there is one number for "this is a bomb, not a payload". deflate-raw tops out
 * near 1032:1, so 150 leaves honest JSON far more headroom than it needs.
 * @type {number}
 */
const ATTEST_BATCH_MAX_INFLATE_RATIO = 150;

/**
 * The per-row fields the batch carries, in canonical order: every
 * `attestation_responses` column except `id` (hub-local paging cursor),
 * `finalized_at` (hub wall clock, audit only) and `batch_action_index` (set by
 * the batch landing itself, so a batch cannot carry its own).
 *
 * Carrying `signatures` and `signer_pubkeys` is what makes a batch-fed node's
 * `attests` rows byte-identical to a mirror-fed node's: the per-row responsible
 * -set signatures ride the chain, not just the batch quorum's.
 * @type {string[]}
 */
const ATTEST_BATCH_ROW_FIELDS = [
    'network',
    'request_id',
    'request_action_index',
    'request_block_index',
    'provider_id',
    'status',
    'response_payload',
    'response_hash',
    'meta',
    'effective_time',
    'signer_pubkeys',
    'signatures',
    'widen'
];

/**
 * Failure reasons. STABLE STRINGS: they reach the chain inside the action's
 * recorded status, so a rename rewrites history on replay.
 * @type {Object<string,string>}
 */
const FAIL = {
    STRUCTURE:     'structure',
    BATCH_KEY:     'batch-key',
    CRC_FORMAT:    'crc32-format',
    CHUNK_INDEX:   'chunk-index',
    TOTAL_CHUNKS:  'total-chunks',
    COVERAGE:      'chunk-coverage',
    BASE64:        'non-canonical-base64',
    RATIO_CAP:     'ratio-cap',
    SIZE_CAP:      'size-cap',
    INFLATE:       'inflate-failed',
    NOT_UTF8:      'non-utf8',
    CRC_MISMATCH:  'crc32-mismatch',
    BODY_JSON:     'body-json',
    ROW_COUNT:     'row-count',
    ROW_FIELD:     'row-field',
    OVERSIZE:      'oversize-body'
};

// Standard alphabet, canonical padding, nothing else. The URL-safe alphabet is a
// DIFFERENT encoding, and accepting both would give one payload two wire
// spellings, which is a fork waiting for the node whose runtime is less
// forgiving.
const CANONICAL_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const HEX64  = /^[0-9a-f]{64}$/;
const CRC_RE = /^[0-9a-f]{8}$/;
const UINT   = /^(0|[1-9][0-9]*)$/;

module.exports = {
    ATTEST_BATCH_HEAD_VERSION,
    ATTEST_BATCH_CONTINUATION_VERSION,
    ATTEST_BATCH_WIRE_MAX_BYTES,
    ATTEST_BATCH_MAX_INFLATED_BYTES,
    ATTEST_BATCH_MAX_ROWS,
    ATTEST_BATCH_MAX_CHUNKS,
    ATTEST_BATCH_MAX_INFLATE_RATIO,
    ATTEST_BATCH_ROW_FIELDS,
    FAIL,
    CANONICAL_BASE64,
    HEX64,
    CRC_RE,
    UINT
};
