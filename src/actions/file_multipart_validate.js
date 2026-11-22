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

function decimalInteger(value) {
    const text = String(value);
    return /^(?:0|[1-9]\d*)$/.test(text) ? Number(text) : NaN;
}

// The refusal a version 2 part draws when it carries no bytes. The read-only dry-runs build a
// synthetic transaction with no payload, so they name this exact status to tell a part they
// cannot judge from one the chain refuses.
const EMPTY_PART_ERROR = 'invalid: RAW_DATA (empty part)';

function validateMultipartFields(data, error, limits) {
    if (!error && !/^[0-9a-f]{64}$/.test(String(data['FILE_HASH'])))
        error = 'invalid: FILE_HASH (format)';

    const totalParts = decimalInteger(data['TOTAL_PARTS']);
    const totalBytes = decimalInteger(data['TOTAL_BYTES']);
    const partIndex = decimalInteger(data['PART_INDEX']);
    const version = String(data['VERSION']);
    const rawData = data['RAW_DATA'];

    if (version === '1') {
        if (!error && (!Number.isInteger(totalParts) || totalParts < 2 || totalParts > limits.maxParts))
            error = 'invalid: TOTAL_PARTS (range)';
        if (!error && (!Number.isInteger(totalBytes) || totalBytes < 1 || totalBytes > limits.maxBytes))
            error = 'invalid: TOTAL_BYTES (range)';
        if (!error && rawData != null && rawData.length !== 0)
            error = 'invalid: RAW_DATA (manifest carries no bytes)';
    }

    if (version === '2') {
        if (!error && (!Number.isInteger(partIndex) || partIndex < 0 || partIndex >= limits.maxParts))
            error = 'invalid: PART_INDEX (range)';
        if (!error && (rawData == null || rawData.length === 0))
            error = EMPTY_PART_ERROR;
    }

    return { error, totalParts, totalBytes, partIndex };
}

function checkMultipartBatch(data, error) {
    if (error) return error;

    if (String(data['VERSION']) === '2' &&
        Object.prototype.hasOwnProperty.call(data, 'BATCH_POSITION'))
        return 'invalid: VERSION (batch)';

    const siblings = Array.isArray(data['SIBLING_ACTIONS']) ? data['SIBLING_ACTIONS'] : [];
    const fileCount = siblings.filter((sibling) => sibling.action === 'FILE').length;
    if (String(data['VERSION']) === '1' && fileCount > 1)
        return 'invalid: FILE_HASH (batch)';

    return error;
}

module.exports = { validateMultipartFields, checkMultipartBatch, EMPTY_PART_ERROR };
