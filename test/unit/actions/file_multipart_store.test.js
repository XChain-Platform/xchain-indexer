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
    partDigestOf,
    sanitizeMultipartRow,
} = require('../../../src/actions/file_multipart_store.js');

const FILE_HASH = 'a'.repeat(64);
const EMPTY_DIGEST = 'e3b0c44298fc1c149afbf4c8996fb924' +
    '27ae41e4649b934ca495991b7852b855';

describe('FILE multipart storage helpers', function () {
    describe('sanitizeMultipartRow', function () {
        it('keeps the wire fields of a valid manifest', function () {
            assert.deepStrictEqual(sanitizeMultipartRow({
                FILE_HASH,
                TOTAL_PARTS: '2',
                TOTAL_BYTES: '389921',
            }), {
                FILE_HASH,
                TOTAL_PARTS: 2,
                TOTAL_BYTES: 389921,
                PART_INDEX: 0,
            });
        });

        it('keeps the wire fields of a valid part', function () {
            assert.deepStrictEqual(sanitizeMultipartRow({
                FILE_HASH,
                PART_INDEX: '1',
            }), {
                FILE_HASH,
                TOTAL_PARTS: 0,
                TOTAL_BYTES: 0,
                PART_INDEX: 1,
            });
        });

        it('replaces a malformed or uppercase hash', function () {
            assert.strictEqual(sanitizeMultipartRow({ FILE_HASH: 'bad' }).FILE_HASH, '');
            assert.strictEqual(sanitizeMultipartRow({ FILE_HASH: 'A'.repeat(64) }).FILE_HASH, '');
        });

        it('replaces leading-zero and non-numeric integer spellings', function () {
            const leadingZero = sanitizeMultipartRow({
                TOTAL_PARTS: '02',
                TOTAL_BYTES: '01',
                PART_INDEX: '00',
            });
            assert.deepStrictEqual(leadingZero, {
                FILE_HASH: '',
                TOTAL_PARTS: 0,
                TOTAL_BYTES: 0,
                PART_INDEX: 0,
            });

            const nonNumeric = sanitizeMultipartRow({
                TOTAL_PARTS: 'two',
                TOTAL_BYTES: '1.5',
                PART_INDEX: '-1',
            });
            assert.deepStrictEqual(nonNumeric, leadingZero);
        });

        it('keeps each multipart integer through its storage maximum', function () {
            const maximum = sanitizeMultipartRow({
                TOTAL_PARTS: '4294967295',
                TOTAL_BYTES: '262140000000',
                PART_INDEX: '4294967295',
            });
            assert.deepStrictEqual(maximum, {
                FILE_HASH: '',
                TOTAL_PARTS: 4294967295,
                TOTAL_BYTES: 262140000000,
                PART_INDEX: 4294967295,
            });
        });

        it('replaces values above each multipart integer storage width', function () {
            const overflow = sanitizeMultipartRow({
                TOTAL_PARTS: '4294967296',
                TOTAL_BYTES: '9007199254740992',
                PART_INDEX: '4294967296',
            });
            assert.deepStrictEqual(overflow, {
                FILE_HASH: '',
                TOTAL_PARTS: 0,
                TOTAL_BYTES: 0,
                PART_INDEX: 0,
            });
        });

        it('uses storage-safe placeholders for absent fields', function () {
            assert.deepStrictEqual(sanitizeMultipartRow({}), {
                FILE_HASH: '',
                TOTAL_PARTS: 0,
                TOTAL_BYTES: 0,
                PART_INDEX: 0,
            });
        });
    });

    describe('partDigestOf', function () {
        it('returns the empty digest for absent, null, and zero-length bytes', function () {
            for (const rawData of [undefined, null, Buffer.alloc(0), new Uint8Array(0)]) {
                assert.deepStrictEqual(partDigestOf(rawData), {
                    byteLength: 0,
                    partDigest: EMPTY_DIGEST,
                });
            }
        });

        it('hashes exactly the fixed Buffer bytes', function () {
            assert.deepStrictEqual(partDigestOf(Buffer.from([0x61, 0x62, 0x63])), {
                byteLength: 3,
                partDigest: 'ba7816bf8f01cfea414140de5dae2223' +
                    'b00361a396177a9cb410ff61f20015ad',
            });
        });

        it('hashes exactly the bytes in a Uint8Array view', function () {
            const bytes = new Uint8Array([0xff, 0x61, 0x62, 0x63, 0xff]).subarray(1, 4);
            assert.deepStrictEqual(partDigestOf(bytes), {
                byteLength: 3,
                partDigest: 'ba7816bf8f01cfea414140de5dae2223' +
                    'b00361a396177a9cb410ff61f20015ad',
            });
        });

        it('throws instead of hashing a string as text', function () {
            assert.throws(() => partDigestOf('abc'), TypeError);
        });
    });
});
