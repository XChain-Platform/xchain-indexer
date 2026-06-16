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
 **********************************************************************
 * Tier 1 Fuzz: Validation functions
 *
 * Tests that all pure validation functions in utility.js never throw
 * and return expected types for any input.
 */

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const fc = require('fast-check');
const { NUM_RUNS, createMockIndexer } = require('../setup/harness');
const { validAmount, invalidAmount, anyAmount, decimalsValue } = require('../generators/amounts');
const { anyAddress } = require('../generators/addresses');

describe('Tier 1 - Validation functions @tier1', function () {
    this.timeout(0);
    let util;

    before(function () {
        util = createMockIndexer().util;
    });

    describe('isValidAmountFormat(decimals, amount)', function () {
        it('never throws for any (decimals, amount) pair', function () {
            fc.assert(fc.property(
                decimalsValue(), anyAmount(),
                (decimals, amount) => {
                    util.isValidAmountFormat(decimals, amount);
                }
            ), { numRuns: NUM_RUNS });
        });

        it('returns false for all negative strings', function () {
            fc.assert(fc.property(
                fc.integer({ min: 1, max: 999999 }).map(n => '-' + n),
                (amount) => {
                    assert.strictEqual(util.isValidAmountFormat(0, amount), false);
                    assert.strictEqual(util.isValidAmountFormat(8, amount), false);
                }
            ), { numRuns: NUM_RUNS });
        });

        it('returns true for valid positive integer amounts with decimals=0', function () {
            fc.assert(fc.property(
                fc.integer({ min: 0, max: 999999999 }).map(String),
                (amount) => {
                    assert.strictEqual(util.isValidAmountFormat(0, amount), true);
                }
            ), { numRuns: NUM_RUNS });
        });

        it('returns true for valid decimal amounts with decimals>0', function () {
            fc.assert(fc.property(
                validAmount(8),
                (amount) => {
                    assert.strictEqual(util.isValidAmountFormat(8, amount), true);
                }
            ), { numRuns: NUM_RUNS });
        });

        it('always returns a boolean', function () {
            fc.assert(fc.property(
                decimalsValue(), fc.oneof(anyAmount(), fc.anything()),
                (decimals, amount) => {
                    const result = util.isValidAmountFormat(decimals, amount);
                    assert.strictEqual(typeof result, 'boolean');
                }
            ), { numRuns: NUM_RUNS });
        });
    });

    describe('isValidFiatFormat(decimals, amount)', function () {
        it('never throws for any (decimals, amount) pair', function () {
            fc.assert(fc.property(
                decimalsValue(), anyAmount(),
                (decimals, amount) => {
                    util.isValidFiatFormat(decimals, amount);
                }
            ), { numRuns: NUM_RUNS });
        });

        it('result is always a subset of isValidAmountFormat', function () {
            fc.assert(fc.property(
                fc.integer({ min: 0, max: 18 }), anyAmount(),
                (decimals, amount) => {
                    const fiatValid = util.isValidFiatFormat(decimals, amount);
                    const amountValid = util.isValidAmountFormat(decimals, amount);
                    if (fiatValid) assert.strictEqual(amountValid, true);
                }
            ), { numRuns: NUM_RUNS });
        });
    });

    describe('isValidLockValue(value)', function () {
        it('never throws for primitive inputs', function () {
            fc.assert(fc.property(
                fc.oneof(
                    fc.string(), fc.integer(), fc.double({ noNaN: false }),
                    fc.constant(null), fc.constant(undefined), fc.constant(true), fc.constant(false),
                    fc.constant(''), fc.constant('0'), fc.constant('1'), fc.constant('abc'),
                ),
                (value) => {
                    util.isValidLockValue(value);
                }
            ), { numRuns: NUM_RUNS });
        });

        it('returns true only for 0 and 1 (and their string equivalents)', function () {
            fc.assert(fc.property(
                fc.oneof(
                    fc.integer({ min: 2, max: 1000 }),
                    fc.integer({ min: -1000, max: -1 }),
                    fc.constantFrom(null, undefined, '', 'abc', 0.5, true, false, NaN, Infinity, [], {}),
                ),
                (value) => {
                    assert.strictEqual(util.isValidLockValue(value), false);
                }
            ), { numRuns: NUM_RUNS });
        });

        it('accepts 0, 1, "0", "1"', function () {
            assert.strictEqual(util.isValidLockValue(0), true);
            assert.strictEqual(util.isValidLockValue(1), true);
            assert.strictEqual(util.isValidLockValue('0'), true);
            assert.strictEqual(util.isValidLockValue('1'), true);
        });
    });

    describe('isValidTransactionHash(hash)', function () {
        it('never throws for string inputs', function () {
            fc.assert(fc.property(
                fc.oneof(fc.string(), fc.integer().map(String), fc.constant(''), fc.constant(null)),
                (hash) => {
                    util.isValidTransactionHash(hash);
                }
            ), { numRuns: NUM_RUNS });
        });

        it('returns 1 only for 64-char strings', function () {
            fc.assert(fc.property(
                fc.string({ minLength: 0, maxLength: 100 }),
                (hash) => {
                    const result = util.isValidTransactionHash(hash);
                    if (hash.length === 64) assert.strictEqual(result, 1);
                    else assert.strictEqual(result, 0);
                }
            ), { numRuns: NUM_RUNS });
        });
    });

    describe('isCryptoAddress(address)', function () {
        it('never throws for string inputs', function () {
            fc.assert(fc.property(
                fc.oneof(fc.string(), fc.integer().map(String), fc.constant(''), fc.constant(null)),
                (address) => {
                    util.isCryptoAddress(address);
                }
            ), { numRuns: NUM_RUNS });
        });

        it('accepts generated valid addresses and rejects invalid ones', function () {
            const { cryptoAddress, invalidAddress } = require('../generators/addresses');
            fc.assert(fc.property(
                cryptoAddress(),
                (address) => {
                    assert.strictEqual(util.isCryptoAddress(address), true);
                }
            ), { numRuns: NUM_RUNS });
            fc.assert(fc.property(
                invalidAddress(),
                (address) => {
                    assert.strictEqual(util.isCryptoAddress(address), false);
                }
            ), { numRuns: NUM_RUNS });
        });

        it('rejects random strings (no checksum collision)', function () {
            fc.assert(fc.property(
                fc.string({ minLength: 0, maxLength: 100 }),
                (address) => {
                    // A random string passing full base58check/bech32 validation
                    // would require a 1-in-2^32 checksum collision
                    assert.strictEqual(util.isCryptoAddress(address), false);
                }
            ), { numRuns: NUM_RUNS });
        });
    });

    describe('isNumeric(value)', function () {
        it('never throws for primitive inputs', function () {
            fc.assert(fc.property(
                fc.oneof(
                    fc.string(),
                    fc.integer(),
                    fc.double({ noNaN: false }),
                    fc.constant(null),
                    fc.constant(undefined),
                    fc.constant(true),
                    fc.constant(false),
                    fc.constant(''),
                    fc.bigInt(),
                ),
                (value) => {
                    const result = util.isNumeric(value);
                    assert.strictEqual(typeof result, 'boolean');
                }
            ), { numRuns: NUM_RUNS });
        });

        it('returns true for all finite numbers', function () {
            fc.assert(fc.property(
                fc.double({ noNaN: true, noDefaultInfinity: true }),
                (value) => {
                    assert.strictEqual(util.isNumeric(value), true);
                }
            ), { numRuns: NUM_RUNS });
        });

        it('returns false for NaN and Infinity', function () {
            assert.strictEqual(util.isNumeric(NaN), false);
            assert.strictEqual(util.isNumeric(Infinity), false);
            assert.strictEqual(util.isNumeric(-Infinity), false);
        });
    });

    describe('isInteger(value)', function () {
        it('never throws for string and number inputs', function () {
            fc.assert(fc.property(
                fc.oneof(
                    fc.string(),
                    fc.integer(),
                    fc.double({ noNaN: false }),
                    fc.constant(null),
                    fc.constant(undefined),
                    fc.constant(''),
                    fc.constant(true),
                    fc.constant(false),
                ),
                (value) => {
                    util.isInteger(value);
                }
            ), { numRuns: NUM_RUNS });
        });

        it('returns false for objects (no longer crashes)', function () {
            assert.strictEqual(util.isInteger({ toString: false }), false);
            assert.strictEqual(util.isInteger({}), false);
            assert.strictEqual(util.isInteger(null), false);
        });

        it('returns true for integer values', function () {
            fc.assert(fc.property(
                fc.integer(),
                (value) => {
                    assert.strictEqual(util.isInteger(value), true);
                }
            ), { numRuns: NUM_RUNS });
        });
    });

    describe('isNull(value)', function () {
        it('never throws for primitive inputs', function () {
            fc.assert(fc.property(
                fc.oneof(
                    fc.string(), fc.integer(), fc.double({ noNaN: false }),
                    fc.constant(null), fc.constant(undefined), fc.constant(false), fc.constant(0),
                ),
                (value) => {
                    const result = util.isNull(value);
                    assert.strictEqual(typeof result, 'boolean');
                }
            ), { numRuns: NUM_RUNS });
        });

        it('returns true only for null, undefined, and empty string', function () {
            assert.strictEqual(util.isNull(null), true);
            assert.strictEqual(util.isNull(undefined), true);
            assert.strictEqual(util.isNull(''), true);
            assert.strictEqual(util.isNull(0), false);
            assert.strictEqual(util.isNull(false), false);
            assert.strictEqual(util.isNull('a'), false);
        });
    });

    describe('isValidValue(value, valid)', function () {
        it('never throws for primitive (value, valid) pairs', function () {
            fc.assert(fc.property(
                fc.oneof(fc.string(), fc.integer(), fc.double({ noNaN: false }), fc.constant(null)),
                fc.oneof(
                    fc.string(),
                    fc.array(fc.oneof(fc.integer(), fc.string()), { minLength: 0, maxLength: 10 }),
                ),
                (value, valid) => {
                    util.isValidValue(value, valid);
                }
            ), { numRuns: NUM_RUNS });
        });
    });

    describe('getFormatVersion(format)', function () {
        it('never throws for string, number, null, undefined inputs', function () {
            fc.assert(fc.property(
                fc.oneof(
                    fc.string(),
                    fc.integer(),
                    fc.double({ noNaN: false }),
                    fc.constant(null),
                    fc.constant(undefined),
                    fc.constant(''),
                ),
                (format) => {
                    util.getFormatVersion(format);
                }
            ), { numRuns: NUM_RUNS });
        });

        it('returns null for objects (no longer crashes)', function () {
            assert.strictEqual(util.getFormatVersion({ toString: null }), null);
            assert.strictEqual(util.getFormatVersion({}), null);
            assert.strictEqual(util.getFormatVersion([]), null);
        });

        it('returns an integer, 0, or null — never NaN or undefined', function () {
            fc.assert(fc.property(
                fc.oneof(fc.string(), fc.integer(), fc.float(), fc.constant(undefined), fc.constant(null)),
                (format) => {
                    const result = util.getFormatVersion(format);
                    assert.ok(
                        result === null || (typeof result === 'number' && Number.isInteger(result)),
                        `Expected null or integer, got ${result}`
                    );
                }
            ), { numRuns: NUM_RUNS });
        });

        it('returns format for valid integer strings 0-255', function () {
            fc.assert(fc.property(
                fc.integer({ min: 0, max: 255 }),
                (n) => {
                    assert.strictEqual(util.getFormatVersion(String(n)), n);
                }
            ), { numRuns: 256 });
        });
    });
});
