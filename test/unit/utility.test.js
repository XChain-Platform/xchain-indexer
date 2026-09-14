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
// Utility: the helper class every handler and the block loop lean on. The suite
// is split by behaviour into files beside this one in utility.test/ (block_loop,
// validation, bignumber, format_and_ledger, fees_and_transforms); every block in
// every file opens the same 'Utility @regression @tier1' describe with a fresh
// Utility per test, so no full test title depends on which file its block is in.
// This file keeps the list management and number-predicate cases.

const assert = require('assert');

// Set env before requiring Utility (it loads config in constructor)
process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const Utility = require('../../src/utility.js');

// Every test gets a fresh Utility: the address and ticker lists it tracks live
// on the instance.
let util;
function freshUtil() { util = new Utility(); }

describe('Utility @regression @tier1', function () {
    beforeEach(freshUtil);

    // ─── List Management ──────────────────────────────────────────

    describe('resetAddressesList()', function () {
        it('should clear the addresses object', function () {
            util.addresses = { addr1: ['TICK1'] };
            util.resetAddressesList();
            assert.deepStrictEqual(util.addresses, {});
        });
    });

    describe('resetTickersList()', function () {
        it('should clear the tickers array', function () {
            util.tickers = ['TICK1'];
            util.resetTickersList();
            assert.deepStrictEqual(util.tickers, []);
        });
    });

    describe('resetLists()', function () {
        it('should clear both addresses and tickers', function () {
            util.addresses = { addr1: ['TICK1'] };
            util.tickers = ['TICK1'];
            util.resetLists();
            assert.deepStrictEqual(util.addresses, {});
            assert.deepStrictEqual(util.tickers, []);
        });
    });

    describe('getAddressesList()', function () {
        it('should return current addresses object', function () {
            util.addresses = { a: ['T'] };
            assert.deepStrictEqual(util.getAddressesList(), { a: ['T'] });
        });
    });

    describe('getTickersList()', function () {
        it('should return current tickers array', function () {
            util.tickers = ['T'];
            assert.deepStrictEqual(util.getTickersList(), ['T']);
        });
    });
});

describe('Utility @regression @tier1', function () {
    beforeEach(freshUtil);

    // ─── isNumeric ────────────────────────────────────────────────

    describe('isNumeric()', function () {
        it('should return true for integers', function () {
            assert.strictEqual(util.isNumeric(42), true);
        });
        it('should return true for floats', function () {
            assert.strictEqual(util.isNumeric(3.14), true);
        });
        it('should return true for numeric strings', function () {
            assert.strictEqual(util.isNumeric('100'), true);
            assert.strictEqual(util.isNumeric('3.14'), true);
        });
        it('should return true for zero', function () {
            assert.strictEqual(util.isNumeric(0), true);
            assert.strictEqual(util.isNumeric('0'), true);
        });
        it('should return true for negative numbers', function () {
            assert.strictEqual(util.isNumeric(-5), true);
            assert.strictEqual(util.isNumeric('-5'), true);
        });
        it('should return true for BigInt', function () {
            assert.strictEqual(util.isNumeric(BigInt(100)), true);
        });
        it('should return false for non-numeric strings', function () {
            assert.strictEqual(util.isNumeric('abc'), false);
            assert.strictEqual(util.isNumeric('12abc'), false);
        });
        it('should return false for empty string', function () {
            assert.strictEqual(util.isNumeric(''), false);
        });
        it('should return false for null/undefined', function () {
            assert.strictEqual(util.isNumeric(null), false);
            assert.strictEqual(util.isNumeric(undefined), false);
        });
        it('should return false for Infinity', function () {
            assert.strictEqual(util.isNumeric(Infinity), false);
        });
        it('should return false for NaN', function () {
            assert.strictEqual(util.isNumeric(NaN), false);
        });
    });
});

describe('Utility @regression @tier1', function () {
    beforeEach(freshUtil);

    // ─── isFloat ──────────────────────────────────────────────────

    describe('isFloat()', function () {
        it('should return true for float values', function () {
            assert.strictEqual(util.isFloat(1.5), true);
        });
        it('should return false for integers', function () {
            assert.strictEqual(util.isFloat(1), false);
            assert.strictEqual(util.isFloat(0), false);
        });
        it('should return false for strings', function () {
            assert.strictEqual(util.isFloat('1.5'), false);
        });
    });

    // ─── isInteger ────────────────────────────────────────────────

    describe('isInteger()', function () {
        it('should return true for integers', function () {
            assert.strictEqual(util.isInteger(5), true);
            assert.strictEqual(util.isInteger(0), true);
        });
        it('should return true for integer strings', function () {
            assert.strictEqual(util.isInteger('5'), true);
        });
        it('should return false for floats', function () {
            assert.strictEqual(util.isInteger(1.5), false);
        });
        it('should return true for negative integers', function () {
            assert.strictEqual(util.isInteger(-3), true);
        });
    });

    // ─── isNull ───────────────────────────────────────────────────

    describe('isNull()', function () {
        it('should return true for null', function () {
            assert.strictEqual(util.isNull(null), true);
        });
        it('should return true for undefined', function () {
            assert.strictEqual(util.isNull(undefined), true);
        });
        it('should return true for empty string', function () {
            assert.strictEqual(util.isNull(''), true);
        });
        it('should return false for zero', function () {
            assert.strictEqual(util.isNull(0), false);
        });
        it('should return false for false', function () {
            assert.strictEqual(util.isNull(false), false);
        });
        it('should return false for non-empty string', function () {
            assert.strictEqual(util.isNull('hello'), false);
        });
    });
});
