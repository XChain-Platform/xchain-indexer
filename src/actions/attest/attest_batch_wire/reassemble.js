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
 * ATTEST batch wire - chunk coverage and reassembly
 *
 * A part of ../attest_batch_wire.js, the ATTEST v5/v6 batch wire. It is
 * byte-identical in both repos like the entry (xchain-hub src/lib/attest_batch_wire/,
 * xchain-indexer src/actions/attest/attest_batch_wire/), so it requires only node
 * stdlib and its sibling parts, never a path outside this directory.
 *
 * Reassembly runs as four named steps called in a fixed order by
 * reassembleAttestBatch below: concatenate the covered chunks, decode and
 * inflate under the caps, decode the inflated body, then hold the body against
 * the head that declared it. Each step returns a refusal or its output, and the
 * first refusal ends the reassembly, exactly as the single function did.
 *
 ********************************************************************/

'use strict';

const zlib = require('zlib');

const {
    ATTEST_BATCH_MAX_INFLATED_BYTES, ATTEST_BATCH_MAX_ROWS, ATTEST_BATCH_MAX_INFLATE_RATIO,
    ATTEST_BATCH_ROW_FIELDS, FAIL, HEX64
} = require('./constants.js');
const { fail, decodeCanonicalBase64, crc32Hex } = require('./primitives.js');

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

// Step 1: the head's chunk followed by every continuation in slot order. A
// multi-chunk batch missing any slot is refused before a byte is decoded.
function concatenateBatchChunks(head, chunks){
    let b64 = String(head.chunkB64);
    if(head.totalChunks > 1){
        const ordered = attestChunkCoverage(chunks, head.totalChunks);
        if(ordered === null) return fail(FAIL.COVERAGE, head.totalChunks);
        for(const c of ordered) b64 += String(c.chunk_b64 == null ? '' : c.chunk_b64);
    }
    return { ok: true, b64 };
}

// Step 2: canonical base64 over the whole concatenation, then the bounded inflate.
function inflateBatchBody(b64){
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
    return { ok: true, compressed, inflated };
}

// Step 3: the inflated bytes read as one UTF-8 JSON object whose CRC matches the
// head's, carrying row and signature arrays inside the row cap.
function decodeBatchBody(head, inflated){
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
    return { ok: true, parsed };
}

// Step 4: the body must describe the batch the wire header declared, and every
// row and signature entry must carry its full field set. Returns null when it does.
function checkBodyAgainstHead(head, parsed){
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
    return null;
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

    const joined = concatenateBatchChunks(head, chunks);
    if(joined.ok !== true) return joined;

    const body = inflateBatchBody(joined.b64);
    if(body.ok !== true) return body;

    const decoded = decodeBatchBody(head, body.inflated);
    if(decoded.ok !== true) return decoded;

    const mismatch = checkBodyAgainstHead(head, decoded.parsed);
    if(mismatch !== null) return mismatch;

    return {
        ok:              true,
        batch:           decoded.parsed,
        inflatedBytes:   body.inflated.length,
        compressedBytes: body.compressed.length
    };
}

module.exports = {
    attestChunkCoverage,
    reassembleAttestBatch
};
