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
const { validateMultipartFields } = require('../../../src/actions/file_multipart_validate.js');

const FILE_HASH = 'a'.repeat(64);
const LIMITS = { maxParts: 4, maxBytes: 100 };

function manifest(overrides = {}) {
    return Object.assign({
        VERSION: '1',
        FILE_HASH,
        TOTAL_PARTS: '2',
        TOTAL_BYTES: '1',
    }, overrides);
}

function part(overrides = {}) {
    return Object.assign({
        VERSION: '2',
        FILE_HASH,
        PART_INDEX: '0',
        RAW_DATA: Buffer.from('x'),
    }, overrides);
}

function verdict(data, error = null) {
    return validateMultipartFields(data, error, LIMITS).error;
}

describe('FILE multipart field validation', function () {
    it('accepts a valid manifest and returns its canonical integer fields', function () {
        assert.deepStrictEqual(validateMultipartFields(manifest(), null, LIMITS), {
            error: null,
            totalParts: 2,
            totalBytes: 1,
            partIndex: NaN,
        });
    });

    it('accepts a valid part at index zero', function () {
        assert.deepStrictEqual(validateMultipartFields(part(), null, LIMITS), {
            error: null,
            totalParts: NaN,
            totalBytes: NaN,
            partIndex: 0,
        });
    });

    it('rejects a FILE_HASH that is not exactly 64 lowercase hex characters', function () {
        for (const fileHash of ['a'.repeat(63), 'A'.repeat(64), 'g'.repeat(64)])
            assert.strictEqual(verdict(manifest({ FILE_HASH: fileHash })), 'invalid: FILE_HASH (format)');
    });

    it('rejects TOTAL_PARTS below and above its bounds', function () {
        assert.strictEqual(verdict(manifest({ TOTAL_PARTS: '1' })), 'invalid: TOTAL_PARTS (range)');
        assert.strictEqual(verdict(manifest({ TOTAL_PARTS: '5' })), 'invalid: TOTAL_PARTS (range)');
    });

    it('accepts both TOTAL_PARTS bounds', function () {
        assert.strictEqual(verdict(manifest({ TOTAL_PARTS: '2' })), null);
        assert.strictEqual(verdict(manifest({ TOTAL_PARTS: '4' })), null);
    });

    it('rejects TOTAL_BYTES below and above its bounds', function () {
        assert.strictEqual(verdict(manifest({ TOTAL_BYTES: '0' })), 'invalid: TOTAL_BYTES (range)');
        assert.strictEqual(verdict(manifest({ TOTAL_BYTES: '101' })), 'invalid: TOTAL_BYTES (range)');
    });

    it('accepts both TOTAL_BYTES bounds', function () {
        assert.strictEqual(verdict(manifest({ TOTAL_BYTES: '1' })), null);
        assert.strictEqual(verdict(manifest({ TOTAL_BYTES: '100' })), null);
    });

    it('gives every malformed manifest integer its range verdict', function () {
        for (const value of ['02', '-2', '+2', '2.0', '2e0', 'word', '', undefined])
            assert.strictEqual(verdict(manifest({ TOTAL_PARTS: value })), 'invalid: TOTAL_PARTS (range)');
        for (const value of ['01', '-1', '+1', '1.0', '1e0', 'word', '', undefined])
            assert.strictEqual(verdict(manifest({ TOTAL_BYTES: value })), 'invalid: TOTAL_BYTES (range)');
    });

    it('rejects a manifest carrying non-empty RAW_DATA', function () {
        assert.strictEqual(
            verdict(manifest({ RAW_DATA: Buffer.from('x') })),
            'invalid: RAW_DATA (manifest carries no bytes)'
        );
    });

    it('accepts an absent, null, or zero-length manifest RAW_DATA', function () {
        assert.strictEqual(verdict(manifest()), null);
        assert.strictEqual(verdict(manifest({ RAW_DATA: null })), null);
        assert.strictEqual(verdict(manifest({ RAW_DATA: Buffer.alloc(0) })), null);
    });

    it('rejects PART_INDEX below and above its bounds', function () {
        assert.strictEqual(verdict(part({ PART_INDEX: '-1' })), 'invalid: PART_INDEX (range)');
        assert.strictEqual(verdict(part({ PART_INDEX: '4' })), 'invalid: PART_INDEX (range)');
    });

    it('accepts both PART_INDEX bounds including zero', function () {
        assert.strictEqual(verdict(part({ PART_INDEX: '0' })), null);
        assert.strictEqual(verdict(part({ PART_INDEX: '3' })), null);
    });

    it('gives every malformed PART_INDEX its range verdict', function () {
        for (const value of ['00', '+0', '0.0', '0e0', 'word', '', undefined])
            assert.strictEqual(verdict(part({ PART_INDEX: value })), 'invalid: PART_INDEX (range)');
    });

    it('rejects an absent, null, or zero-length part RAW_DATA', function () {
        const absent = part();
        delete absent['RAW_DATA'];
        assert.strictEqual(verdict(absent), 'invalid: RAW_DATA (empty part)');
        assert.strictEqual(verdict(part({ RAW_DATA: null })), 'invalid: RAW_DATA (empty part)');
        assert.strictEqual(verdict(part({ RAW_DATA: Buffer.alloc(0) })), 'invalid: RAW_DATA (empty part)');
    });

    it('keeps manifest failures in FILE_HASH, TOTAL_PARTS, TOTAL_BYTES, RAW_DATA order', function () {
        const data = manifest({
            FILE_HASH: 'bad',
            TOTAL_PARTS: '1',
            TOTAL_BYTES: '0',
            RAW_DATA: Buffer.from('x'),
        });
        assert.strictEqual(verdict(data), 'invalid: FILE_HASH (format)');
        data['FILE_HASH'] = FILE_HASH;
        assert.strictEqual(verdict(data), 'invalid: TOTAL_PARTS (range)');
        data['TOTAL_PARTS'] = '2';
        assert.strictEqual(verdict(data), 'invalid: TOTAL_BYTES (range)');
        data['TOTAL_BYTES'] = '1';
        assert.strictEqual(verdict(data), 'invalid: RAW_DATA (manifest carries no bytes)');
    });

    it('keeps part failures in FILE_HASH, PART_INDEX, RAW_DATA order', function () {
        const data = part({ FILE_HASH: 'bad', PART_INDEX: '4', RAW_DATA: Buffer.alloc(0) });
        assert.strictEqual(verdict(data), 'invalid: FILE_HASH (format)');
        data['FILE_HASH'] = FILE_HASH;
        assert.strictEqual(verdict(data), 'invalid: PART_INDEX (range)');
        data['PART_INDEX'] = '0';
        assert.strictEqual(verdict(data), 'invalid: RAW_DATA (empty part)');
    });

    it('preserves an earlier verdict', function () {
        assert.strictEqual(verdict(manifest({ FILE_HASH: 'bad' }), 'invalid: SOURCE'), 'invalid: SOURCE');
    });
});
