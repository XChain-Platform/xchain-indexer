// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// Utility, fees and data helpers: transaction, action and expiration fees, prices,
// number coercion, hashing and sorting, address/ticker tracking and the timer
// string. Part of the Utility suite; see ../utility.test.js.

const assert = require('assert');

// Set env before requiring Utility (it loads config in constructor)
process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const Utility = require('../../../../src/utility.js');

// Every test gets a fresh Utility: the address and ticker lists it tracks live
// on the instance.
let util;
function freshUtil() { util = new Utility(); }

describe('Utility @regression @tier1', function () {
    beforeEach(freshUtil);

    // ─── Fee Calculation ──────────────────────────────────────────

    describe('getTransactionFee()', function () {
        it('should return 0 for 0 db hits', function () {
            const fee = util.getTransactionFee(0, 'BTC');
            assert.strictEqual(util.bcformat(fee, 8), '0.00000000');
        });
        it('should calculate fee for 1 db hit', function () {
            // 1 * 1000 sats * 0.00000001 = 0.00001000
            const fee = util.getTransactionFee(1, 'BTC');
            assert.strictEqual(util.bcformat(fee, 8), '0.00001000');
        });
        it('should calculate fee for 10 db hits', function () {
            // 10 * 1000 * 0.00000001 = 0.00010000
            const fee = util.getTransactionFee(10, 'BTC');
            assert.strictEqual(util.bcformat(fee, 8), '0.00010000');
        });
        it('should calculate fee for 100 db hits', function () {
            const fee = util.getTransactionFee(100, 'BTC');
            assert.strictEqual(util.bcformat(fee, 8), '0.00100000');
        });
    });

    describe('feeForAction()', function () {
        it('returns the fee unchanged for a normal on-wire action', function () {
            assert.strictEqual(util.feeForAction('0.00010000', { IS_EMISSION: false }), '0.00010000');
        });
        it('returns the fee unchanged when no emission flag is present', function () {
            assert.strictEqual(util.feeForAction('0.00010000', {}), '0.00010000');
            assert.strictEqual(util.feeForAction('0.00010000', null), '0.00010000');
        });
        it('returns 0 for a VM-emitted (IS_EMISSION) action', function () {
            assert.strictEqual(util.feeForAction('0.00010000', { IS_EMISSION: true }), '0');
        });
    });
});

describe('Utility @regression @tier1', function () {
    beforeEach(freshUtil);

    describe('getExpirationFee()', function () {
        it('should return 0 for format 0 within free days', function () {
            // 182 days free, expiration within free period
            const data = {
                FORMAT: 0,
                BLOCK_TIME: 1000000,
                EXPIRATION: 1000000 + (180 * 86400), // 180 days
            };
            const fee = util.getExpirationFee(data, null);
            assert.strictEqual(Number(fee), 0);
        });
        it('should calculate fee for format 0 beyond free days', function () {
            const data = {
                FORMAT: 0,
                BLOCK_TIME: 1000000,
                EXPIRATION: 1000000 + (365 * 86400), // 365 days
            };
            const fee = util.getExpirationFee(data, null);
            // 365 days > 182 free → fee = 365 * PER_DAY
            assert.ok(Number(fee.toString()) > 0);
        });
        it('should return 0 for format 2 when not extending expiration', function () {
            const data = {
                FORMAT: 2,
                EXPIRATION: 1000,
            };
            const info = {
                EXPIRATION: 2000,
                BLOCK_TIME: 100,
            };
            const fee = util.getExpirationFee(data, info);
            assert.strictEqual(Number(fee), 0);
        });
    });

    describe('getDefaultExpiration()', function () {
        it('should add EXPIRATION_FEE_DEFAULT_DAYS in seconds to block_time', function () {
            const result = util.getDefaultExpiration(1000000);
            // 90 days * 86400 = 7776000 seconds
            const expected = 1000000 + (90 * 86400);
            assert.strictEqual(result.toString(), String(expected));
        });
    });

    describe('getPrice()', function () {
        it('should calculate price as numerator / denominator', function () {
            const result = util.getPrice(100, 50);
            assert.strictEqual(parseFloat(result.toString()), 2);
        });
        it('should use custom precision', function () {
            const result = util.getPrice(1, 3, 8);
            assert.strictEqual(result.toString(), '0.33333333');
        });
    });
});

describe('Utility @regression @tier1', function () {
    beforeEach(freshUtil);

    // ─── Data Transformation ──────────────────────────────────────

    describe('setNumberFormats()', function () {
        it('leaves numeric STRING fields as strings (string is the canonical form)', function () {
            // setNumberFormats only coerces non-string numerics to bignumber
            // (guard: typeof value !== 'string'). Wire/amount values are strings
            // everywhere, so they pass through untouched: no float/bignumber drift.
            const data = { AMOUNT: '100', DECIMALS: '8' };
            const result = util.setNumberFormats(data);
            assert.strictEqual(typeof result.AMOUNT, 'string');
            assert.strictEqual(result.AMOUNT, '100');
        });
        it('coerces a non-string numeric field to bignumber', function () {
            const data = { AMOUNT: 100 };
            const result = util.setNumberFormats(data);
            assert.strictEqual(typeof result.AMOUNT, 'object'); // bignumber
            assert.strictEqual(result.AMOUNT.toString(), '100');
        });
        it('should leave non-number-field values unchanged', function () {
            const data = { TICK: 'TEST', AMOUNT: '100' };
            const result = util.setNumberFormats(data);
            assert.strictEqual(result.TICK, 'TEST');
        });
        it('should leave null values as null', function () {
            const data = { AMOUNT: null };
            const result = util.setNumberFormats(data);
            assert.strictEqual(result.AMOUNT, null);
        });
        it('should leave non-numeric values for validation to catch', function () {
            const data = { AMOUNT: 'abc' };
            const result = util.setNumberFormats(data);
            assert.strictEqual(result.AMOUNT, 'abc');
        });
    });

    describe('jsonStringify()', function () {
        it('should serialize normal objects', function () {
            assert.strictEqual(util.jsonStringify({ a: 1 }), '{"a":1}');
        });
        it('should handle BigInt', function () {
            const result = util.jsonStringify({ big: BigInt(123456789) });
            assert.strictEqual(result, '{"big":"123456789"}');
        });
    });
});

describe('Utility @regression @tier1', function () {
    beforeEach(freshUtil);

    describe('getDataHash()', function () {
        it('should return deterministic SHA256 hash', function () {
            const hash1 = util.getDataHash({ a: 1, b: 2 });
            const hash2 = util.getDataHash({ a: 1, b: 2 });
            assert.strictEqual(hash1, hash2);
            assert.strictEqual(hash1.length, 64);
        });
        it('should return different hash for different data', function () {
            const hash1 = util.getDataHash({ a: 1 });
            const hash2 = util.getDataHash({ a: 2 });
            assert.notStrictEqual(hash1, hash2);
        });
    });

    describe('ksort()', function () {
        it('should sort object keys alphabetically', function () {
            const result = util.ksort({ c: 3, a: 1, b: 2 });
            assert.deepStrictEqual(Object.keys(result), ['a', 'b', 'c']);
        });
        it('should handle empty object', function () {
            assert.deepStrictEqual(util.ksort({}), {});
        });
    });

    describe('sortPriceActionIndex()', function () {
        it('should sort by GET_PRICE descending, then ACTION_INDEX descending', function () {
            const data = [
                { GET_PRICE: '1', ACTION_INDEX: 2 },
                { GET_PRICE: '2', ACTION_INDEX: 1 },
                { GET_PRICE: '1', ACTION_INDEX: 1 },
            ];
            util.sortPriceActionIndex(data);
            assert.strictEqual(data[0].GET_PRICE, '2');
            assert.strictEqual(data[1].ACTION_INDEX, 2);
            assert.strictEqual(data[2].ACTION_INDEX, 1);
        });
        it('should break GET_PRICE ties by ACTION_INDEX descending (matching the code comment)', function () {
            const data = [
                { GET_PRICE: '5', ACTION_INDEX: 10 },
                { GET_PRICE: '5', ACTION_INDEX: 30 },
                { GET_PRICE: '5', ACTION_INDEX: 20 },
            ];
            util.sortPriceActionIndex(data);
            assert.deepStrictEqual(
                data.map((d) => d.ACTION_INDEX),
                [30, 20, 10]
            );
        });
    });
});

describe('Utility @regression @tier1', function () {
    beforeEach(freshUtil);

    // ─── Address/Ticker Tracking ──────────────────────────────────

    describe('addAddressTicker()', function () {
        it('should add a single ticker to an address', function () {
            util.addAddressTicker('addr1', 'TICK1');
            assert.deepStrictEqual(util.addresses['addr1'], ['TICK1']);
            assert.deepStrictEqual(util.tickers, ['TICK1']);
        });
        it('should add multiple tickers via array', function () {
            util.addAddressTicker('addr1', ['TICK1', 'TICK2']);
            assert.deepStrictEqual(util.addresses['addr1'], ['TICK1', 'TICK2']);
            assert.deepStrictEqual(util.tickers, ['TICK1', 'TICK2']);
        });
        it('should not duplicate tickers', function () {
            util.addAddressTicker('addr1', 'TICK1');
            util.addAddressTicker('addr1', 'TICK1');
            assert.deepStrictEqual(util.addresses['addr1'], ['TICK1']);
            assert.strictEqual(util.tickers.length, 1);
        });
        it('should track tickers across addresses', function () {
            util.addAddressTicker('addr1', 'TICK1');
            util.addAddressTicker('addr2', 'TICK1');
            assert.strictEqual(util.tickers.length, 1);
        });
        it('should handle undefined ticker without crashing', function () {
            util.addAddressTicker('addr1', undefined);
            assert.deepStrictEqual(util.addresses['addr1'], []);
        });
    });

    // ─── Timer ────────────────────────────────────────────────────

    describe('millisecondsToTimeString()', function () {
        it('should handle seconds', function () {
            const result = util.millisecondsToTimeString(5500);
            assert.ok(result.includes('05.5s'));
        });
        it('should handle minutes', function () {
            const result = util.millisecondsToTimeString(90000);
            assert.ok(result.includes('01m'));
        });
        it('should return empty for 0ms', function () {
            assert.strictEqual(util.millisecondsToTimeString(0), '');
        });
    });
});
