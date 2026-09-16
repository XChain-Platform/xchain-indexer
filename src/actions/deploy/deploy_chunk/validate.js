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
 * XChain Platform - DEPLOY v4 (chunk carrier): FORMAT validations
 *
 * The wire checks a carrier's four fields must pass before its gas fee is
 * priced. A part of actions/deploy/deploy_chunk.js, whose parse() calls it
 * right after extracting the params; every verdict string here is consensus
 * (it lands on the deploy_chunks row) and the order is first-failure-wins.
 *
 ********************************************************************/

/**
 * Validate one carrier's CODE_HASH, CHUNK_INDEX, TOTAL_CHUNKS and CODE_PART.
 *
 * @param {DeployChunk} carrier  the owning chunk handler (its util and byte caps)
 * @param {object}      data     the carrier's transaction context, params already extracted
 * @param {?string}     error    a verdict already reached, or null
 * @returns {{error: ?string, chunkIndex: number, totalChunks: number}}
 */
function validateChunkFormat(carrier, data, error){

    /*****************************************************************
     * FORMAT Validations
     ****************************************************************/

    // CODE_HASH must be a 64-char lowercase sha256 hex string (the group id)
    if(!error && !/^[0-9a-f]{64}$/.test(String(data['CODE_HASH'])))
        error = 'invalid: CODE_HASH (format)';

    // CHUNK_INDEX / TOTAL_CHUNKS must be non-negative integers
    if(!error && !/^\d+$/.test(String(data['CHUNK_INDEX'])))
        error = 'invalid: CHUNK_INDEX (format)';
    // Verify TOTAL_CHUNKS is a non-negative whole number
    if(!error && !/^\d+$/.test(String(data['TOTAL_CHUNKS'])))
        error = 'invalid: TOTAL_CHUNKS (format)';

    let chunkIndex  = Number(data['CHUNK_INDEX']);
    let totalChunks = Number(data['TOTAL_CHUNKS']);

    // TOTAL_CHUNKS must be within [1, MAX_DEPLOY_CHUNKS]
    if(!error && (totalChunks < 1 || totalChunks > carrier.MAX_DEPLOY_CHUNKS))
        error = 'invalid: TOTAL_CHUNKS (out of range)';

    // CHUNK_INDEX must address a position inside the group
    if(!error && chunkIndex >= totalChunks)
        error = 'invalid: CHUNK_INDEX (out of range)';

    // CODE_PART must be present and a base64-alphabet string. It is a SLICE of
    // base64(code), not necessarily independently decodable, so we validate the
    // alphabet only; the assembling DEPLOY concatenates all parts then decodes +
    // sha256-verifies the whole.
    if(!error && carrier.util.isNull(data['CODE_PART']))
        error = 'invalid: CODE_PART (required)';
    // Verify CODE_PART only contains valid base64 characters
    if(!error && !/^[A-Za-z0-9+/]*={0,2}$/.test(String(data['CODE_PART'])))
        error = 'invalid: CODE_PART (base64)';

    // CODE_PART must stay within the per-chunk byte budget (belt-and-suspenders:
    // the decoder already drops any action whose compiled push exceeds the cap)
    if(!error && Buffer.byteLength(String(data['CODE_PART']), 'utf8') > carrier.MAX_DEPLOYCHUNK_PART_BYTES)
        error = 'invalid: CODE_PART (exceeds max size)';

    return { error, chunkIndex, totalChunks };
}

module.exports = { validateChunkFormat };
