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
 * ATTEST v5/v6 batch wire: the periodic on-chain carrier for finalized
 * attestation responses.
 *
 * An attestation response reaches every indexer through the hub mirror rather
 * than on a validator-paid transaction. That leaves one obligation the mirror
 * cannot discharge on its own: full history must stay reconstructible from
 * chain parse, so every terminal response body also lands on chain in a
 * periodic batch. This module is that batch's wire, and nothing else: encode a
 * window of rows into an ATTEST v5 head plus v6 continuations, and decode and
 * reassemble them back.
 *
 * SELF-CONTAINED BY CONTRACT. xchain-hub carries a byte-identical twin of this
 * file at src/lib/attest_batch_wire.js, because the hub BUILDS the wire and the
 * indexer PARSES it, and two hand-written layouts of one wire is the failure
 * that parallel building invites. The twin sits at a different directory depth,
 * so a relative require that resolves here would not resolve there: this file
 * therefore requires nothing but node stdlib, and the pieces it needs from
 * price_batch_compression.js (canonical base64, the bounded inflate, the crc32
 * fallback) are inlined for that reason rather than shared. Edit one copy, then
 * re-vendor; the parity test in both repos fails on any one-sided edit.
 *
 * THE CAPS ARE CONSENSUS. The compressed bytes are the action body, so a size
 * or row-count breach must be invalid on every node or the fleet forks on the
 * first hostile batch. The inflate is bounded through zlib's maxOutputLength so
 * a bomb is refused rather than absorbed and then rejected.
 *
 * NOTHING HERE IS SIGNED. The batch quorum signs the canonical body content,
 * never the compressed or chunked bytes: DEFLATE output is allowed to vary
 * across zlib versions and levels, so two honest publishers may emit different
 * wires for the same window and neither is wrong. Only INFLATION has to be
 * deterministic, and RFC 1951 pins that. Never compare, hash, or sign the
 * compressed bytes.
 *
 * Design: the response-mirror spec's batch section, on the ANCHOR v1/v2
 * chunking precedent (TOTAL_CHUNKS, CHUNK_INDEX, BATCH_CRC32, coverage-verified
 * reassembly).
 *
 ********************************************************************/

'use strict';

const crypto = require('crypto');
const zlib   = require('zlib');

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
 * failing the wire: a head declaring 4294967296 parses, actions/attest.js stamps
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

/**
 * A structured refusal. Callers record the action invalid on it and must never
 * retry the bytes under a looser rule: that retry is how one node reads a batch
 * the next node rejects.
 * @param {string} reason one of FAIL
 * @param {*} [detail] optional diagnostic value, never consensus input
 * @returns {{ok:false, reason:string, status:string, detail:*}}
 */
function fail(reason, detail){
    return {
        ok:     false,
        reason: reason,
        status: 'invalid: ATTEST_BATCH (' + reason + ')',
        detail: (detail === undefined) ? null : detail
    };
}

/**
 * Decode a strictly canonical base64 string, or null when the input is not the
 * one canonical spelling of its own bytes.
 *
 * The re-encode comparison is the part that matters and the part a naive
 * implementation omits: the regex and the length check reject wrong CHARACTERS,
 * and only the round trip rejects a right-looking string whose final quantum
 * carries bits that decode to nothing ('QR==' and 'QQ==' both meaning 0x41).
 * @param {string} field
 * @returns {Buffer|null}
 */
function decodeCanonicalBase64(field){
    if(typeof field !== 'string')     return null;
    if(field.length === 0)            return null;
    if(field.length % 4 !== 0)        return null;
    if(!CANONICAL_BASE64.test(field)) return null;
    const buf = Buffer.from(field, 'base64');
    if(buf.length === 0)              return null;
    if(buf.toString('base64') !== field) return null;
    return buf;
}

/**
 * CRC32 of a buffer as 8 lower-case hex characters. zlib.crc32 where the runtime
 * has it, else the same polynomial by hand, so two nodes on different Node minor
 * versions agree.
 * @param {Buffer} buf
 * @returns {string}
 */
function crc32Hex(buf){
    let n;
    if(typeof zlib.crc32 === 'function'){
        n = zlib.crc32(buf);
    } else {
        let c, crc = 0xFFFFFFFF;
        for(let i = 0; i < buf.length; i++){
            c = (crc ^ buf[i]) & 0xFF;
            for(let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            crc = (crc >>> 8) ^ c;
        }
        n = (crc ^ 0xFFFFFFFF) >>> 0;
    }
    return (n >>> 0).toString(16).padStart(8, '0');
}

/**
 * The batch's identity on the wire: sha256 over the window it covers. This is
 * the correlation key a continuation names, so a v6 can find its head without
 * the publisher allocating a sequence number that two publishers could collide
 * on. Derived from signed window bounds alone, so every node computes it alike.
 * @param {{network:string, window_start:number|string, window_end:number|string}} window
 * @returns {string} 64 lower-case hex characters
 */
function computeBatchKey(window){
    const preimage = 'ATTESTBATCH:' + String(window.network) + ':' +
                     String(window.window_start) + ':' + String(window.window_end);
    return crypto.createHash('sha256').update(preimage, 'utf8').digest('hex');
}

// Rows reduced to the carried field set, in ATTEST_BATCH_ROW_FIELDS order. A row
// object built ad hoc in two places drifts, and a drifted row changes the signed
// canonical, so every serializer below goes through here.
function normalizeBatchRows(window){
    return (window.rows || []).map((r) => {
        const out = {};
        for(const f of ATTEST_BATCH_ROW_FIELDS)
            out[f] = (r[f] === undefined) ? null : r[f];
        return out;
    });
}

function batchHeaderObject(window){
    return {
        network:          String(window.network),
        window_start:     Number(window.window_start),
        window_end:       Number(window.window_end),
        row_count:        Number(window.row_count),
        btc_block_height: Number(window.btc_block_height)
    };
}

/**
 * THE SIGNED BYTES of a batch: the window header plus its rows, and deliberately
 * NOT the signatures, which cannot sign themselves. Every batch signer signs this
 * exact string and every verifier rebuilds it from the reassembled body, so the
 * two sides agree without the compressed or chunked bytes ever entering the
 * preimage. Insertion order IS the field order in JSON.stringify, so the object
 * literal above is the canonical's definition; never reorder it.
 * @param {Object} window
 * @returns {string}
 */
function buildAttestBatchCanonical(window){
    const header = batchHeaderObject(window);
    header.rows  = normalizeBatchRows(window);
    return JSON.stringify(header);
}

/**
 * The full body a batch carries: the signed canonical's content plus the
 * signature set that covers it. This is the exact string both sides deflate and
 * inflate.
 * @param {Object} window the window to serialize
 * @returns {string}
 */
function buildAttestBatchBody(window){
    const body = batchHeaderObject(window);
    body.rows  = normalizeBatchRows(window);
    body.sigs  = (window.sigs || []).map((s) => ({
        pubkey: String(s.pubkey || '').toLowerCase(),
        sig:    String(s.sig || '').toLowerCase()
    }));
    return JSON.stringify(body);
}

// Wire layouts, declared once so the encoder and both parsers read from one
// place. params[0] is VERSION on every XChain action, so the field lists below
// start at params[1].
const HEAD_FORMAT =
    'VERSION|BATCH_KEY|NETWORK|WINDOW_START|WINDOW_END|ROW_COUNT|BTC_BLOCK_HEIGHT|BATCH_CRC32|TOTAL_CHUNKS|BODY_B64';
const CONTINUATION_FORMAT =
    'VERSION|BATCH_KEY|CHUNK_INDEX|TOTAL_CHUNKS|BATCH_CRC32|BODY_B64_CHUNK';

function headPrefix(window, batchKey, crc, totalChunks){
    return 'ATTEST|' + ATTEST_BATCH_HEAD_VERSION + '|' + batchKey + '|' +
           String(window.network) + '|' + String(window.window_start) + '|' +
           String(window.window_end) + '|' + String(window.row_count) + '|' +
           String(window.btc_block_height) + '|' + crc + '|' + String(totalChunks) + '|';
}

function continuationPrefix(batchKey, chunkIndex, totalChunks, crc){
    return 'ATTEST|' + ATTEST_BATCH_CONTINUATION_VERSION + '|' + batchKey + '|' +
           String(chunkIndex) + '|' + String(totalChunks) + '|' + crc + '|';
}

/**
 * Encode one window into the wires that carry it.
 *
 * EMIT SIDE ONLY. The chunk split and the compression level have no consensus
 * weight: reassembly is plain concatenation, so any split a publisher chooses
 * reassembles to the same bytes. The split below is nonetheless deterministic so
 * the hub twin and this copy produce identical wires for identical input, which
 * is what the parity test can assert.
 *
 * @param {{network:string, window_start:number, window_end:number, row_count:number,
 *          btc_block_height:number, rows:Object[], sigs:{pubkey:string,sig:string}[]}} window
 * @returns {{ok:true, batchKey:string, batchCrc32:string, totalChunks:number,
 *            wires:string[], body:string, inflatedBytes:number, compressedBytes:number}
 *          |{ok:false, reason:string, status:string, detail:*}}
 */
function encodeAttestBatch(window){
    if(!window || typeof window !== 'object') return fail(FAIL.STRUCTURE, 'window is not an object');
    const rows = Array.isArray(window.rows) ? window.rows : null;
    if(rows === null) return fail(FAIL.STRUCTURE, 'rows is not an array');
    if(rows.length > ATTEST_BATCH_MAX_ROWS) return fail(FAIL.ROW_COUNT, rows.length);
    if(Number(window.row_count) !== rows.length) return fail(FAIL.ROW_COUNT, 'row_count does not match rows.length');

    const body = buildAttestBatchBody(window);
    const bodyBytes = Buffer.from(body, 'utf8');
    if(bodyBytes.length > ATTEST_BATCH_MAX_INFLATED_BYTES) return fail(FAIL.OVERSIZE, bodyBytes.length);

    const batchKey = computeBatchKey(window);
    const crc      = crc32Hex(bodyBytes);
    const b64      = zlib.deflateRawSync(bodyBytes, { level: zlib.constants.Z_BEST_COMPRESSION }).toString('base64');

    // Smallest chunk count whose prefixes still leave room for the payload. The
    // prefixes grow with the digit width of TOTAL_CHUNKS and CHUNK_INDEX, so the
    // capacity is recomputed per candidate rather than assumed.
    let totalChunks = 1, headCap = 0, contCap = 0;
    for(;; totalChunks++){
        headCap = ATTEST_BATCH_WIRE_MAX_BYTES - Buffer.byteLength(headPrefix(window, batchKey, crc, totalChunks), 'utf8');
        contCap = ATTEST_BATCH_WIRE_MAX_BYTES -
                  Buffer.byteLength(continuationPrefix(batchKey, totalChunks - 1, totalChunks, crc), 'utf8');
        if(headCap <= 0 || (totalChunks > 1 && contCap <= 0)) return fail(FAIL.OVERSIZE, 'wire prefix leaves no payload room');
        if(headCap + (totalChunks - 1) * contCap >= b64.length) break;
    }

    const wires = [];
    let cursor  = headCap;
    wires.push(headPrefix(window, batchKey, crc, totalChunks) + b64.slice(0, headCap));
    for(let i = 1; i < totalChunks; i++){
        wires.push(continuationPrefix(batchKey, i, totalChunks, crc) + b64.slice(cursor, cursor + contCap));
        cursor += contCap;
    }

    return {
        ok:              true,
        batchKey:        batchKey,
        batchCrc32:      crc,
        totalChunks:     totalChunks,
        wires:           wires,
        body:            body,
        inflatedBytes:   bodyBytes.length,
        compressedBytes: b64.length
    };
}

/**
 * Parse an ATTEST v5 head wire's positional params into its structural fields.
 * Structure only: nothing here inflates, verifies a quorum, or judges coverage.
 * @param {Array} params positional wire fields, params[0] the VERSION
 * @returns {{ok:true, batchKey:string, network:string, windowStart:number, windowEnd:number,
 *            rowCount:number, btcBlockHeight:number, batchCrc32:string, totalChunks:number, chunkB64:string}
 *          |{ok:false, reason:string, status:string, detail:*}}
 */
function parseAttestBatchHead(params){
    if(!Array.isArray(params)) return fail(FAIL.STRUCTURE, 'params is not an array');
    const batchKey = String(params[1] == null ? '' : params[1]).toLowerCase();
    if(!HEX64.test(batchKey)) return fail(FAIL.BATCH_KEY, batchKey.length);

    const network = String(params[2] == null ? '' : params[2]);
    if(network.length === 0 || network.length > 20) return fail(FAIL.STRUCTURE, 'NETWORK');

    for(const [name, raw] of [['WINDOW_START', params[3]], ['WINDOW_END', params[4]],
                              ['ROW_COUNT', params[5]], ['BTC_BLOCK_HEIGHT', params[6]]]){
        if(!UINT.test(String(raw == null ? '' : raw))) return fail(FAIL.STRUCTURE, name);
    }
    const windowStart    = Number(params[3]);
    const windowEnd      = Number(params[4]);
    const rowCount       = Number(params[5]);
    const btcBlockHeight = Number(params[6]);
    if(windowStart > windowEnd) return fail(FAIL.STRUCTURE, 'WINDOW_START > WINDOW_END');
    // Resolved BEFORE anything consumes it: an attacker-supplied count drives a
    // parse loop on every indexing node, reached by one cheap transaction.
    if(rowCount > ATTEST_BATCH_MAX_ROWS) return fail(FAIL.ROW_COUNT, rowCount);

    const crc = String(params[7] == null ? '' : params[7]).toLowerCase();
    if(!CRC_RE.test(crc)) return fail(FAIL.CRC_FORMAT, crc);

    if(!UINT.test(String(params[8] == null ? '' : params[8]))) return fail(FAIL.TOTAL_CHUNKS, params[8]);
    const totalChunks = Number(params[8]);
    // Bounded on BOTH sides, like ROW_COUNT above and for the same two reasons: the
    // count is attacker-supplied, and an unbounded one reaches an INT UNSIGNED column
    // and a reader that cannot return the set whole.
    if(totalChunks < 1 || totalChunks > ATTEST_BATCH_MAX_CHUNKS) return fail(FAIL.TOTAL_CHUNKS, totalChunks);

    const chunkB64 = String(params[9] == null ? '' : params[9]);
    if(chunkB64.length === 0 || !CANONICAL_BASE64.test(chunkB64)) return fail(FAIL.BASE64, 'head chunk');

    // The batch key is derived from the window it names, so a head that declares
    // one window under another window's key is refused here rather than reaching
    // a continuation that would then reassemble under the wrong identity.
    const expectedKey = computeBatchKey({ network, window_start: windowStart, window_end: windowEnd });
    if(expectedKey !== batchKey) return fail(FAIL.BATCH_KEY, 'does not derive from the declared window');

    return {
        ok: true,
        batchKey, network, windowStart, windowEnd,
        rowCount, btcBlockHeight,
        batchCrc32: crc, totalChunks, chunkB64
    };
}

/**
 * Parse an ATTEST v6 continuation wire's positional params.
 * @param {Array} params positional wire fields, params[0] the VERSION
 * @returns {{ok:true, batchKey:string, chunkIndex:number, totalChunks:number,
 *            batchCrc32:string, chunkB64:string}
 *          |{ok:false, reason:string, status:string, detail:*}}
 */
function parseAttestBatchContinuation(params){
    if(!Array.isArray(params)) return fail(FAIL.STRUCTURE, 'params is not an array');
    const batchKey = String(params[1] == null ? '' : params[1]).toLowerCase();
    if(!HEX64.test(batchKey)) return fail(FAIL.BATCH_KEY, batchKey.length);

    if(!UINT.test(String(params[2] == null ? '' : params[2]))) return fail(FAIL.CHUNK_INDEX, params[2]);
    if(!UINT.test(String(params[3] == null ? '' : params[3]))) return fail(FAIL.TOTAL_CHUNKS, params[3]);
    const chunkIndex  = Number(params[2]);
    const totalChunks = Number(params[3]);
    // Index 0 is the head's own slot, so a continuation claiming it is refused
    // rather than allowed to displace the head in the coverage set. The upper bound is
    // the head's, so the two wires of one batch cannot disagree about the geometry the
    // reader and the chunk columns have to hold; CHUNK_INDEX is then bounded by it.
    if(totalChunks < 2 || totalChunks > ATTEST_BATCH_MAX_CHUNKS) return fail(FAIL.TOTAL_CHUNKS, totalChunks);
    if(chunkIndex < 1 || chunkIndex >= totalChunks) return fail(FAIL.CHUNK_INDEX, chunkIndex);

    const crc = String(params[4] == null ? '' : params[4]).toLowerCase();
    if(!CRC_RE.test(crc)) return fail(FAIL.CRC_FORMAT, crc);

    const chunkB64 = String(params[5] == null ? '' : params[5]);
    if(chunkB64.length === 0 || !CANONICAL_BASE64.test(chunkB64)) return fail(FAIL.BASE64, 'continuation chunk');

    return { ok: true, batchKey, chunkIndex, totalChunks, batchCrc32: crc, chunkB64 };
}

/**
 * Order a chunk set into slots 1..totalChunks-1, or null when coverage is
 * incomplete. Duplicates are resolved deterministically by keeping the LOWEST
 * `action_index`, so two nodes holding the same chunk rows in different read
 * orders reassemble the same bytes.
 * @param {{chunk_index:number, chunk_b64:string, action_index:(number|undefined)}[]} chunks
 * @param {number} totalChunks
 * @returns {Object[]|null} the ordered chunk rows, or null when a slot is missing
 */
function attestChunkCoverage(chunks, totalChunks){
    const total = Number(totalChunks);
    if(!Number.isInteger(total) || total < 1) return null;
    const bySlot = new Map();
    for(const c of (chunks || [])){
        const idx = Number(c && c.chunk_index);
        if(!Number.isInteger(idx) || idx < 1 || idx >= total) continue;
        const held = bySlot.get(idx);
        if(held === undefined) { bySlot.set(idx, c); continue; }
        const a = Number(held.action_index), b = Number(c.action_index);
        if(Number.isFinite(b) && (!Number.isFinite(a) || b < a)) bySlot.set(idx, c);
    }
    const ordered = [];
    for(let i = 1; i < total; i++){
        const row = bySlot.get(i);
        if(row === undefined) return null;
        ordered.push(row);
    }
    return ordered;
}

/**
 * Reassemble a head plus its continuations back into the window they carry.
 *
 * THE ORDER OF THE STEPS IS ITSELF CONSENSUS: coverage, concatenation, canonical
 * base64, bounded inflate, CRC, JSON, caps. Each step's input is the previous
 * step's output, so reordering two of them changes which batches a node accepts.
 * The CRC is checked on the INFLATED body, matching the ANCHOR archive rule.
 *
 * @param {Object} head the parseAttestBatchHead result for this batch
 * @param {{chunk_index:number, chunk_b64:string, action_index:(number|undefined)}[]} chunks
 * @returns {{ok:true, batch:Object, inflatedBytes:number, compressedBytes:number}
 *          |{ok:false, reason:string, status:string, detail:*}}
 */
function reassembleAttestBatch(head, chunks){
    if(!head || head.ok !== true) return fail(FAIL.STRUCTURE, 'head is not a parsed batch head');

    let b64 = String(head.chunkB64);
    if(head.totalChunks > 1){
        const ordered = attestChunkCoverage(chunks, head.totalChunks);
        if(ordered === null) return fail(FAIL.COVERAGE, head.totalChunks);
        for(const c of ordered) b64 += String(c.chunk_b64 == null ? '' : c.chunk_b64);
    }

    // Canonicality is asserted on the CONCATENATION, never per chunk: a chunk
    // boundary may split a base64 quantum, so a per-chunk check would reject
    // honest splits and admit nothing extra.
    const compressed = decodeCanonicalBase64(b64);
    if(compressed === null) return fail(FAIL.BASE64, 'reassembled body');

    // Which bound binds is a function of the compressed length alone, so every
    // node picks the same one and reports the same reason for the same wire.
    const ratioCap  = compressed.length * ATTEST_BATCH_MAX_INFLATE_RATIO;
    const outputCap = Math.min(ATTEST_BATCH_MAX_INFLATED_BYTES, ratioCap);
    const bindingReason = (ratioCap <= ATTEST_BATCH_MAX_INFLATED_BYTES) ? FAIL.RATIO_CAP : FAIL.SIZE_CAP;

    let inflated;
    try {
        // maxOutputLength is the whole defense: zlib stops at the bound instead
        // of allocating the full inflated size first, so a bomb is refused rather
        // than absorbed and rejected afterwards.
        inflated = zlib.inflateRawSync(compressed, { maxOutputLength: outputCap });
    } catch(e){
        if(e && e.code === 'ERR_BUFFER_TOO_LARGE') return fail(bindingReason, outputCap);
        return fail(FAIL.INFLATE, e && e.message ? e.message : null);
    }
    if(inflated.length === 0) return fail(FAIL.INFLATE, 'empty body');

    // Buffer.toString('utf8') maps every invalid byte sequence to U+FFFD, which
    // would make many distinct payloads produce one identical body. One wire, one
    // meaning: the round trip is what forbids that.
    const body = inflated.toString('utf8');
    if(!Buffer.from(body, 'utf8').equals(inflated)) return fail(FAIL.NOT_UTF8);

    if(crc32Hex(inflated) !== head.batchCrc32) return fail(FAIL.CRC_MISMATCH, head.batchCrc32);

    let parsed;
    try { parsed = JSON.parse(body); }
    catch(e){ return fail(FAIL.BODY_JSON, e && e.message ? e.message : null); }
    if(!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail(FAIL.BODY_JSON, 'not an object');

    if(!Array.isArray(parsed.rows) || !Array.isArray(parsed.sigs)) return fail(FAIL.STRUCTURE, 'rows/sigs');
    if(parsed.rows.length > ATTEST_BATCH_MAX_ROWS) return fail(FAIL.ROW_COUNT, parsed.rows.length);

    // The header the wire declares and the body the quorum signed must describe
    // one batch. A disagreement is refused rather than resolved in either
    // direction: the header keys the gates, the body carries the rows, and
    // letting them differ would let a publisher choose which one a node reads.
    if(String(parsed.network) !== head.network ||
       Number(parsed.window_start) !== head.windowStart ||
       Number(parsed.window_end) !== head.windowEnd ||
       Number(parsed.btc_block_height) !== head.btcBlockHeight ||
       Number(parsed.row_count) !== head.rowCount)
        return fail(FAIL.STRUCTURE, 'body header does not match the wire header');
    if(Number(parsed.row_count) !== parsed.rows.length) return fail(FAIL.ROW_COUNT, 'row_count does not match rows.length');

    for(const r of parsed.rows){
        if(!r || typeof r !== 'object' || Array.isArray(r)) return fail(FAIL.ROW_FIELD, 'row is not an object');
        for(const f of ATTEST_BATCH_ROW_FIELDS)
            if(!(f in r)) return fail(FAIL.ROW_FIELD, f);
    }
    for(const s of parsed.sigs){
        if(!s || typeof s !== 'object') return fail(FAIL.ROW_FIELD, 'sig entry');
        if(!HEX64.test(String(s.pubkey || '').toLowerCase())) return fail(FAIL.ROW_FIELD, 'sig pubkey');
        if(!/^[0-9a-f]{128}$/.test(String(s.sig || '').toLowerCase())) return fail(FAIL.ROW_FIELD, 'sig value');
    }

    return {
        ok:              true,
        batch:           parsed,
        inflatedBytes:   inflated.length,
        compressedBytes: compressed.length
    };
}

module.exports = {
    ATTEST_BATCH_HEAD_VERSION,
    ATTEST_BATCH_CONTINUATION_VERSION,
    ATTEST_BATCH_WIRE_MAX_BYTES,
    ATTEST_BATCH_MAX_INFLATED_BYTES,
    ATTEST_BATCH_MAX_ROWS,
    ATTEST_BATCH_MAX_CHUNKS,
    ATTEST_BATCH_MAX_INFLATE_RATIO,
    ATTEST_BATCH_ROW_FIELDS,
    ATTEST_BATCH_FAIL_REASONS: FAIL,
    ATTEST_BATCH_HEAD_FORMAT: HEAD_FORMAT,
    ATTEST_BATCH_CONTINUATION_FORMAT: CONTINUATION_FORMAT,
    computeBatchKey,
    buildAttestBatchCanonical,
    buildAttestBatchBody,
    encodeAttestBatch,
    parseAttestBatchHead,
    parseAttestBatchContinuation,
    attestChunkCoverage,
    reassembleAttestBatch,
    decodeCanonicalBase64,
    crc32Hex
};
