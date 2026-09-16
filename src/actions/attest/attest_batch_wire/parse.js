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
 * ATTEST batch wire - head and continuation parsers
 *
 * A part of ../attest_batch_wire.js, the ATTEST v5/v6 batch wire. It is
 * byte-identical in both repos like the entry (xchain-hub src/lib/attest_batch_wire/,
 * xchain-indexer src/actions/attest/attest_batch_wire/), so it requires only node
 * stdlib and its sibling parts, never a path outside this directory.
 *
 * Structure only: each parser checks field shapes and bounds on one wire and
 * returns its fields. Nothing here inflates, verifies a quorum or judges coverage.
 *
 ********************************************************************/

'use strict';

const {
    ATTEST_BATCH_MAX_ROWS, ATTEST_BATCH_MAX_CHUNKS, FAIL,
    CANONICAL_BASE64, HEX64, CRC_RE, UINT
} = require('./constants.js');
const { fail, computeBatchKey } = require('./primitives.js');

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

module.exports = {
    parseAttestBatchHead,
    parseAttestBatchContinuation
};
