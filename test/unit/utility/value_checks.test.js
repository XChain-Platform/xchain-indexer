/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/
const assert = require('assert');
const checks = require('../../../src/utility/value_checks.js');

describe('value checks: type predicates', function(){
    it('isNumeric accepts numbers, numeric strings and bigint', function(){
        for(const v of [5, '5', 5.5, 10n, '1e3'])
            assert.strictEqual(checks.isNumeric.call(checks, v), true, String(v));
    });

    it('isNumeric rejects non-numeric values', function(){
        for(const v of ['abc', '', null, NaN, Infinity])
            assert.strictEqual(checks.isNumeric.call(checks, v), false, String(v));
    });

    it('isFloat is true only for a fractional number', function(){
        assert.strictEqual(checks.isFloat.call(checks, 1.5), true);
        for(const v of [2, '1.5', NaN])
            assert.strictEqual(checks.isFloat.call(checks, v), false, String(v));
    });

    it('isInteger rejects null, fractions and objects without a whole toNumber', function(){
        const frac = { toNumber(){ return 3.5; } };
        for(const v of [null, undefined, 5.5, {}, 'x', frac])
            assert.strictEqual(checks.isInteger.call(checks, v), false);
    });

    it('isInteger accepts integers, integer strings and whole toNumber objects', function(){
        const whole = { toNumber(){ return 3; } };
        for(const v of [5, '5', whole])
            assert.strictEqual(checks.isInteger.call(checks, v), true);
    });

});

describe('value checks: column range and nulls', function(){
    it('exceedsUnsignedColumn is false for values inside the range', function(){
        for(const v of [null, 255, '255', ' +7 ', '1.5', 'abc'])
            assert.strictEqual(checks.exceedsUnsignedColumn.call(checks, v, 255), false, String(v));
    });

    it('exceedsUnsignedColumn is true for values outside the range', function(){
        for(const v of ['256', '-1', '300.5', '-0.5'])
            assert.strictEqual(checks.exceedsUnsignedColumn.call(checks, v, 255), true, String(v));
    });

    it('exceedsUnsignedColumn compares large integers as BigInt', function(){
        const max = 18446744073709551615n;
        assert.strictEqual(checks.exceedsUnsignedColumn.call(checks, '99999999999999999999999', max), true);
    });

    it('isNull is true for null, undefined and the empty string', function(){
        for(const v of [null, undefined, ''])
            assert.strictEqual(checks.isNull.call(checks, v), true);
        for(const v of [0, '0', false])
            assert.strictEqual(checks.isNull.call(checks, v), false);
    });

    it('isValidTransactionHash checks only the length', function(){
        assert.strictEqual(checks.isValidTransactionHash.call(checks, 'a'.repeat(64)), 1);
        assert.strictEqual(checks.isValidTransactionHash.call(checks, 'a'.repeat(63)), 0);
        assert.strictEqual(checks.isValidTransactionHash.call(checks, undefined), 0);
    });

});

describe('value checks: hash and ksort', function(){
    it('ksort returns a new object with sorted keys and shared nested values', function(){
        const nested = { z: 1 };
        const input = { b: nested, a: 2 };
        const out = checks.ksort.call(checks, input);
        assert.notStrictEqual(out, input);
        assert.deepStrictEqual(Object.keys(out), ['a', 'b']);
        assert.strictEqual(out.b, nested);
    });

    it('ksort lists integer-like keys first in numeric order', function(){
        const out = checks.ksort.call(checks, { b: 1, 10: 1, a: 1, 2: 1 });
        assert.deepStrictEqual(Object.keys(out), ['2', '10', 'a', 'b']);
    });
});
