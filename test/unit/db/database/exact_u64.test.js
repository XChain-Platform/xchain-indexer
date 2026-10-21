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

// exactU64 keeps a u64 above 2^53 exact as a decimal string and hands a safe
// integer back as a Number, so readers can stop rounding user-chosen u64 fields.
const assert = require('assert');
const {
    exactU64,
    exactU64TypeCast,
} = require('../../../../src/db/database/exact_u64.js');

describe('exactU64', function () {
    it('keeps the u64 maximum exact from a string and from a bigint', function () {
        assert.strictEqual(exactU64('18446744073709551615'), '18446744073709551615');
        assert.strictEqual(exactU64(18446744073709551615n), '18446744073709551615');
    });

    it('keeps 2^53 + 1 as a string instead of rounding it', function () {
        assert.strictEqual(exactU64('9007199254740993'), '9007199254740993');
        assert.strictEqual(exactU64(9007199254740993n), '9007199254740993');
    });

    it('returns a Number for a safe integer from a string, bigint or number', function () {
        assert.strictEqual(exactU64('42'), 42);
        assert.strictEqual(exactU64(42n), 42);
        assert.strictEqual(exactU64(42), 42);
        assert.strictEqual(exactU64(String(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
    });

    it('returns null for null and for undefined', function () {
        assert.strictEqual(exactU64(null), null);
        assert.strictEqual(exactU64(undefined), null);
    });

    it('refuses values outside the unsigned 64-bit integer range', function () {
        assert.throws(() => exactU64('18446744073709551616'), RangeError);
        assert.throws(() => exactU64(-1), RangeError);
        assert.throws(() => exactU64(1.5), RangeError);
        assert.throws(() => exactU64('12abc'), TypeError);
    });

    it('type-casts BIGINT fields through the exact u64 boundary', function () {
        const field = { type: 'BIGINT', string: () => '9007199254740993' };
        assert.strictEqual(exactU64TypeCast(field, () => 'fallback'), '9007199254740993');
    });

    it('delegates non-BIGINT fields to the connector', function () {
        let calls = 0;
        const value = exactU64TypeCast({ type: 'INT' }, () => {
            calls += 1;
            return 42;
        });
        assert.strictEqual(value, 42);
        assert.strictEqual(calls, 1);
    });
});
