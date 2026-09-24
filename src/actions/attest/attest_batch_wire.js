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
 * so a relative require that leaves this directory would not resolve there: this
 * file and its parts directory attest_batch_wire/ (byte-identical beside the twin
 * too) therefore require nothing but node stdlib and each other, and the pieces
 * they need from price_batch_compression.js (canonical base64, the bounded
 * inflate, the crc32 fallback) are inlined for that reason rather than shared.
 * Edit one copy, then re-vendor the entry and every part; the parity test in both
 * repos fails on any one-sided edit.
 *
 * WHERE THINGS LIVE. This entry holds the encoder and the exported surface. The
 * constants and failure reasons are in attest_batch_wire/constants.js, the
 * refusal shape, codecs and signed canonical in primitives.js, the two wire
 * parsers in parse.js, and chunk coverage plus reassembly in reassemble.js.
 *
 * TWO ROW FIELD SETS, ONE CHOICE. admit_block_btc joined the rows at the BTC
 * mirror-admission producer activation, so a batch whose signed anchor is below it
 * carries the legacy set and one at or above it carries the admission set. Every
 * entry point that signs, encodes or checks a body takes the caller's era predicate
 * (mirror_admission_gate.js isAdmissionEra) and resolves the set through the one
 * attestBatchRowFields call, so the canonical a quorum signs and the presence check
 * a replaying node applies can never disagree about a batch.
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

const zlib = require('zlib');

const {
    ATTEST_BATCH_HEAD_VERSION, ATTEST_BATCH_CONTINUATION_VERSION, ATTEST_BATCH_WIRE_MAX_BYTES,
    ATTEST_BATCH_MAX_INFLATED_BYTES, ATTEST_BATCH_MAX_ROWS, ATTEST_BATCH_MAX_CHUNKS,
    ATTEST_BATCH_MAX_INFLATE_RATIO, ATTEST_BATCH_LEGACY_ROW_FIELDS, ATTEST_BATCH_ADMISSION_ROW_FIELDS,
    ATTEST_BATCH_ROW_FIELDS, FAIL
} = require('./attest_batch_wire/constants.js');
const {
    fail, decodeCanonicalBase64, crc32Hex, computeBatchKey, attestBatchRowFields,
    requireAdmissionEra, buildAttestBatchCanonical, buildAttestBatchBody
} = require('./attest_batch_wire/primitives.js');
const { parseAttestBatchHead, parseAttestBatchContinuation } = require('./attest_batch_wire/parse.js');
const { attestChunkCoverage, reassembleAttestBatch } = require('./attest_batch_wire/reassemble.js');

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
 * @param {function(string, number): boolean} admissionEra the repo's isAdmissionEra, which
 *        picks the row field set the body carries (see attestBatchRowFields)
 * @returns {{ok:true, batchKey:string, batchCrc32:string, totalChunks:number,
 *            wires:string[], body:string, inflatedBytes:number, compressedBytes:number}
 *          |{ok:false, reason:string, status:string, detail:*}}
 */
function encodeAttestBatch(window, admissionEra){
    requireAdmissionEra(admissionEra);
    if(!window || typeof window !== 'object') return fail(FAIL.STRUCTURE, 'window is not an object');
    const rows = Array.isArray(window.rows) ? window.rows : null;
    if(rows === null) return fail(FAIL.STRUCTURE, 'rows is not an array');
    if(rows.length > ATTEST_BATCH_MAX_ROWS) return fail(FAIL.ROW_COUNT, rows.length);
    if(Number(window.row_count) !== rows.length) return fail(FAIL.ROW_COUNT, 'row_count does not match rows.length');

    const body = buildAttestBatchBody(window, admissionEra);
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

module.exports = {
    ATTEST_BATCH_HEAD_VERSION,
    ATTEST_BATCH_CONTINUATION_VERSION,
    ATTEST_BATCH_WIRE_MAX_BYTES,
    ATTEST_BATCH_MAX_INFLATED_BYTES,
    ATTEST_BATCH_MAX_ROWS,
    ATTEST_BATCH_MAX_CHUNKS,
    ATTEST_BATCH_MAX_INFLATE_RATIO,
    ATTEST_BATCH_LEGACY_ROW_FIELDS,
    ATTEST_BATCH_ADMISSION_ROW_FIELDS,
    ATTEST_BATCH_ROW_FIELDS,
    ATTEST_BATCH_FAIL_REASONS: FAIL,
    ATTEST_BATCH_HEAD_FORMAT: HEAD_FORMAT,
    ATTEST_BATCH_CONTINUATION_FORMAT: CONTINUATION_FORMAT,
    computeBatchKey,
    attestBatchRowFields,
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
