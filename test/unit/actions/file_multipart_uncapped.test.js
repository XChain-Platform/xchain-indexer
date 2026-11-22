// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const assert = require('assert');
const {
    MULTIPART_FILE_MAX_PARTS,
    MULTIPART_FILE_MAX_BYTES,
} = require('../../../src/protocol/constants.js');
const { sanitizeMultipartRow } = require('../../../src/actions/file_multipart_store.js');
const { validateMultipartFields } = require('../../../src/actions/file_multipart_validate.js');

const FILE_HASH = 'a'.repeat(64);
const LIMITS = {
    maxParts: MULTIPART_FILE_MAX_PARTS,
    maxBytes: MULTIPART_FILE_MAX_BYTES,
};

function verdict(data) {
    return validateMultipartFields(data, null, LIMITS).error;
}

describe('FILE multipart uncapped protocol bounds @regression @tier1', function () {
    it('accepts the real manifest and part upper bounds', function () {
        assert.strictEqual(verdict({
            VERSION: '1',
            FILE_HASH,
            TOTAL_PARTS: '65535',
            TOTAL_BYTES: '262140000000',
        }), null);
        assert.strictEqual(verdict({
            VERSION: '2',
            FILE_HASH,
            PART_INDEX: '65534',
            RAW_DATA: Buffer.from('x'),
        }), null);
    });

    it('refuses the first values above the real upper bounds', function () {
        assert.strictEqual(verdict({
            VERSION: '1',
            FILE_HASH,
            TOTAL_PARTS: '65536',
            TOTAL_BYTES: '262140000000',
        }), 'invalid: TOTAL_PARTS (range)');
        assert.strictEqual(verdict({
            VERSION: '2',
            FILE_HASH,
            PART_INDEX: '65535',
            RAW_DATA: Buffer.from('x'),
        }), 'invalid: PART_INDEX (range)');
        assert.strictEqual(verdict({
            VERSION: '1',
            FILE_HASH,
            TOTAL_PARTS: '65535',
            TOTAL_BYTES: '262140000001',
        }), 'invalid: TOTAL_BYTES (range)');
    });

    it('stores safe TOTAL_BYTES spellings beyond the unsigned 32-bit width', function () {
        assert.strictEqual(sanitizeMultipartRow({ TOTAL_BYTES: '5000000000' }).TOTAL_BYTES, 5000000000);
        assert.strictEqual(sanitizeMultipartRow({ TOTAL_BYTES: '262140000000' }).TOTAL_BYTES, 262140000000);
        assert.strictEqual(sanitizeMultipartRow({ TOTAL_BYTES: '90071992547409910' }).TOTAL_BYTES, 0);
    });
});
