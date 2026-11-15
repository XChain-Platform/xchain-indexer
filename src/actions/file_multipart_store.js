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
 ********************************************************************/

'use strict';

const crypto = require('crypto');

const U32_MAX = 4294967295;
const DECIMAL_INTEGER = /^(?:0|[1-9]\d*)$/;
const LOWERCASE_HASH = /^[0-9a-f]{64}$/;

function partDigestOf(rawData) {
    if (rawData != null && !(rawData instanceof Uint8Array))
        throw new TypeError('RAW_DATA must be a Buffer or Uint8Array');

    const bytes = rawData == null ? new Uint8Array(0) : rawData;
    return {
        byteLength: bytes.byteLength,
        partDigest: crypto.createHash('sha256').update(bytes).digest('hex'),
    };
}

function storedU32(value) {
    const text = String(value);
    if (!DECIMAL_INTEGER.test(text)) return 0;
    const number = Number(text);
    return number <= U32_MAX ? number : 0;
}

function sanitizeMultipartRow(data) {
    const fileHash = data['FILE_HASH'];
    return {
        FILE_HASH: LOWERCASE_HASH.test(String(fileHash)) ? fileHash : '',
        TOTAL_PARTS: storedU32(data['TOTAL_PARTS']),
        TOTAL_BYTES: storedU32(data['TOTAL_BYTES']),
        PART_INDEX: storedU32(data['PART_INDEX']),
    };
}

module.exports = { partDigestOf, sanitizeMultipartRow };
