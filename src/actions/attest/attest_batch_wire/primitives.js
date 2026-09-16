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
 * ATTEST batch wire - refusals, codecs and the signed canonical
 *
 * A part of ../attest_batch_wire.js, the ATTEST v5/v6 batch wire. It is
 * byte-identical in both repos like the entry (xchain-hub src/lib/attest_batch_wire/,
 * xchain-indexer src/actions/attest/attest_batch_wire/), so it requires only node
 * stdlib and its sibling parts, never a path outside this directory.
 *
 * The small pieces both directions of the wire share: the structured refusal,
 * the canonical base64 decode, the CRC32, the batch key, and the canonical body
 * serializers the batch quorum signs.
 *
 ********************************************************************/

'use strict';

const crypto = require('crypto');
const zlib   = require('zlib');

const { ATTEST_BATCH_ROW_FIELDS, CANONICAL_BASE64 } = require('./constants.js');

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

module.exports = {
    fail,
    decodeCanonicalBase64,
    crc32Hex,
    computeBatchKey,
    buildAttestBatchCanonical,
    buildAttestBatchBody
};
