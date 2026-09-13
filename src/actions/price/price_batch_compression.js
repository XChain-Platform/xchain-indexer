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
 * PRICE v0 wire compression (spec section 4a).
 *
 * A PRICE batch carries the full pair data of every round in an hourly
 * window, so the uncompressed body runs to several kilobytes against an 8,189
 * byte wire ceiling. The compressed form spends that budget better:
 *
 *     uncompressed:  PRICE|0|<body>
 *     compressed:    PRICE|0|Z|<base64 of deflateRaw(<body>)>
 *
 * `Z` sits in the slot where FIRST_ROUND sits in the uncompressed form.
 * FIRST_ROUND is always a decimal integer and `Z` never is, so the two forms
 * are told apart on the first field after the version with no lookahead.
 *
 * WHY BASE64 AND NOT THE RAW DEFLATE BYTES. Raw deflate output is arbitrary
 * binary: it contains `|` (0x7C) and NUL (0x00) at ordinary frequency. The
 * PRICE wire is a pipe-delimited TEXT action, so raw bytes would split a body
 * into a random number of fields and truncate it at the first NUL. Base64 is
 * what makes the payload expressible in the container it rides in.
 *
 * NOTHING HERE IS EVER SIGNED, and this is the sentence to read before
 * reaching for the compressed bytes as a signing input. The signature set
 * covers buildPriceBatchPayload's canonical JSON of the UNCOMPRESSED content.
 * Compression is applied after signing and stripped before verification.
 * Consequently only INFLATION has to be deterministic, and it is: RFC 1951
 * pins what a deflate stream inflates to. DEFLATE output is explicitly ALLOWED
 * to vary across zlib versions and compression levels, so two honest nodes
 * compressing the same body may emit different bytes, and neither is wrong.
 * Never compare, hash, or sign compressed bytes.
 *
 * THE CAPS BELOW ARE CONSENSUS, unlike the encoder's FILE compression. That
 * mechanism (xchain-encoder/src/compression.js) compresses FILE's separate
 * binary rawData sidecar, records the codec in a FILE-only COMPRESSION field,
 * and GUARD 1 at compression.js:165 refuses every other action outright; its
 * ratio cap is declared presentational-never-consensus because FILE validity
 * never inspects rawData. None of that transfers. Here the compressed bytes
 * ARE the action body, so a ratio or size breach must be INVALID on every node
 * or the fleet forks on the first hostile batch.
 *
 * The bounds are checked BEFORE the inflate buffer is allowed to grow, via
 * zlib's maxOutputLength, so a zip bomb is refused rather than absorbed into
 * memory and rejected afterwards. Two hundred kilobytes of one repeated byte
 * deflate to ~212 bytes, a ratio near 950:1, and every indexing node in the
 * federation would inflate it.
 *
 * Base64 acceptance is STRICTLY canonical. Buffer.from(s, 'base64') is lenient
 * by design: it skips whitespace, accepts the URL-safe alphabet, tolerates
 * missing and malformed padding, and ignores the unused trailing bits of the
 * final quantum. Each of those is a distinct spelling of the same payload, and
 * a consensus rule that accepts many spellings of one meaning is a fork
 * waiting for the node whose runtime is a little less forgiving. One wire, one
 * meaning: the decoded bytes must re-encode to the exact input.
 *
 * Every failure returns a distinct explicit reason and a status string. There
 * is deliberately NO fallback that treats undecodable bytes as an uncompressed
 * body: that fallback is how one node reads a batch the next node rejects.
 *
 * CONSENSUS-CRITICAL and vendored byte-identically into xchain-hub. Edit the
 * xchain-indexer copy and re-vendor; the parity tests in both repos fail on any
 * one-sided edit.
 *
 ********************************************************************/

'use strict';

const zlib = require('zlib');

// Wire marker occupying the FIRST_ROUND slot on the compressed form.
const PRICE_BATCH_COMPRESSION_MARKER = 'Z';

// PRICE wire ceiling. LOCAL COPY: must equal MAX_DATA_BYTES in
// xchain-encoder/src/validator.js, the same value and the same name already
// carried by OraclePublisher.js, AttestationPublisher.js and AttestationRelay.js.
// The vendored twin cannot require across repo boundaries, so the value is
// pinned by test instead: the parity tests read the declaration out of
// xchain-hub/src/OraclePublisher.js and fail if the two ever diverge.
// An inflated body above this could not have ridden the wire uncompressed, so
// admitting one would let the compressed form carry batches the uncompressed
// form cannot express, and the two forms would no longer agree on validity.
const PRICE_WIRE_MAX_BYTES = 8189;

// Consensus inflate ratio cap, matching the encoder's COMPRESSION_MAX_RATIO
// (150) so the platform has one number for "this is a bomb, not a payload".
// Deflate-raw tops out near 1032:1, so 150 leaves honest text far more headroom
// than it needs: the measured six-round batch sits near 4:1.
const PRICE_BATCH_MAX_INFLATE_RATIO = 150;

// Consensus bound on ROUND_COUNT, exported here because the parser reads it
// from the same module that bounds the decompression. An attacker-supplied
// count is a parse-loop DoS on every indexing node, and the wire ceiling
// already makes a batch of more than 256 rounds physically impossible.
const PRICE_BATCH_MAX_ROUND_COUNT = 256;

// Standard alphabet, canonical padding, nothing else. Anchored, no whitespace
// class, no `-` or `_`: the URL-safe alphabet is a DIFFERENT encoding and
// accepting both would give one payload two wire spellings.
const CANONICAL_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

// Failure reasons. Stable strings: they reach the chain inside the action's
// recorded status, so a rename rewrites history on replay.
const FAIL = {
    NOT_A_STRING:  'not-a-string',
    EMPTY:         'empty',
    OVERSIZE:      'oversize-field',
    BASE64:        'non-canonical-base64',
    RATIO_CAP:     'ratio-cap',
    SIZE_CAP:      'size-cap',
    INFLATE:       'inflate-failed',
    NOT_UTF8:      'non-utf8',
    EMPTY_BODY:    'empty-body'
};

function fail(reason, detail){
    return {
        ok:     false,
        reason: reason,
        status: 'invalid: COMPRESSION (' + reason + ')',
        detail: detail || null
    };
}

/**
 * Decode a strictly canonical base64 string.
 *
 * Returns the Buffer, or null when the input is not the one canonical spelling
 * of its own bytes. The re-encode comparison is the part that matters and the
 * part a naive implementation omits: the regex and the length check reject
 * wrong CHARACTERS, and only the round trip rejects a right-looking string
 * whose final quantum carries bits that decode to nothing, such as `QR==` and
 * `QQ==` both meaning the single byte 0x41.
 */
function decodeCanonicalBase64(field){
    if(field.length % 4 !== 0)      return null;
    if(!CANONICAL_BASE64.test(field)) return null;
    const buf = Buffer.from(field, 'base64');
    if(buf.length === 0)            return null;
    if(buf.toString('base64') !== field) return null;
    return buf;
}

/**
 * Compress an uncompressed PRICE v0 body (everything after `PRICE|0|`) into the
 * base64 field the compressed wire carries.
 *
 * EMIT SIDE ONLY, with no consensus weight: the level is chosen for the
 * smallest wire, and a future zlib may produce different bytes at the same
 * level without breaking anything, because readers only ever inflate.
 */
function compressPriceBatchBody(body){
    if(typeof body !== 'string') throw new TypeError('price v2 body must be a string');
    const deflated = zlib.deflateRawSync(Buffer.from(body, 'utf8'),
        { level: zlib.constants.Z_BEST_COMPRESSION });
    return deflated.toString('base64');
}

/**
 * Inflate the base64 field of a compressed PRICE v0 wire back into the
 * uncompressed body.
 *
 * On success: { ok:true, body, compressedBytes, inflatedBytes, ratio }
 * On failure: { ok:false, reason, status, detail } and NOTHING ELSE. The caller
 * must record the action invalid; it must never retry the bytes as a body.
 */
function inflatePriceBatchBody(field){
    if(typeof field !== 'string') return fail(FAIL.NOT_A_STRING);
    if(field.length === 0)        return fail(FAIL.EMPTY);

    // Bound the decode itself. A legitimate compressed field is at most
    // PRICE_WIRE_MAX_BYTES minus the `PRICE|0|Z|` prefix, so this can never
    // reject a wire that could actually exist; it caps the work done on a
    // field handed to this module from anywhere other than a validated wire.
    if(field.length > PRICE_WIRE_MAX_BYTES) return fail(FAIL.OVERSIZE, field.length);

    const compressed = decodeCanonicalBase64(field);
    if(compressed === null) return fail(FAIL.BASE64);

    // The two bounds, resolved to the single number zlib enforces. Which one
    // binds is a function of the compressed length alone, so every node picks
    // the same one and reports the same reason for the same wire.
    const ratioCap  = compressed.length * PRICE_BATCH_MAX_INFLATE_RATIO;
    const outputCap = Math.min(PRICE_WIRE_MAX_BYTES, ratioCap);
    const bindingReason = (ratioCap <= PRICE_WIRE_MAX_BYTES) ? FAIL.RATIO_CAP : FAIL.SIZE_CAP;

    let inflated;
    try {
        // maxOutputLength is the whole defense: zlib stops and throws at the
        // bound instead of allocating the full inflated size first. Refusing
        // afterwards would mean the bomb had already been absorbed.
        inflated = zlib.inflateRawSync(compressed, { maxOutputLength: outputCap });
    } catch(e){
        if(e && e.code === 'ERR_BUFFER_TOO_LARGE') return fail(bindingReason, outputCap);
        return fail(FAIL.INFLATE, e && e.message ? e.message : null);
    }

    if(inflated.length === 0) return fail(FAIL.EMPTY_BODY);

    // The body is text and is about to be split on `|`. Buffer.toString('utf8')
    // maps every invalid byte sequence to U+FFFD, which would make many
    // distinct inflated payloads produce one identical body: the same
    // one-meaning-per-wire property the base64 round trip protects, one layer
    // down. Round-tripping the decode is what forbids it.
    const body = inflated.toString('utf8');
    if(!Buffer.from(body, 'utf8').equals(inflated)) return fail(FAIL.NOT_UTF8);

    return {
        ok:              true,
        body:            body,
        compressedBytes: compressed.length,
        inflatedBytes:   inflated.length,
        ratio:           inflated.length / compressed.length
    };
}

module.exports = {
    PRICE_BATCH_COMPRESSION_MARKER,
    PRICE_WIRE_MAX_BYTES,
    PRICE_BATCH_MAX_INFLATE_RATIO,
    PRICE_BATCH_MAX_ROUND_COUNT,
    PRICE_BATCH_COMPRESSION_FAIL_REASONS: FAIL,
    compressPriceBatchBody,
    inflatePriceBatchBody,
    decodeCanonicalBase64
};
