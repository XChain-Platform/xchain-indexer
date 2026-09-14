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
// Utility, action formats and balances: legacy-format detection, format versions,
// parameter mapping, balance checks and ledger consolidation. Part of the Utility
// suite; see ../utility.test.js.

const assert = require('assert');

// Set env before requiring Utility (it loads config in constructor)
process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const Utility = require('../../../src/utility.js');

// Every test gets a fresh Utility: the address and ticker lists it tracks live
// on the instance.
let util;
function freshUtil() { util = new Utility(); }

describe('Utility @regression @tier1', function () {
    beforeEach(freshUtil);

    // ─── Format Parsing ───────────────────────────────────────────

    describe('isLegacyActionFormat()', function () {
        it('should return false for numeric version "0"', function () {
            assert.strictEqual(util.isLegacyActionFormat(['0', 'TEST']), false);
        });
        it('should return false for numeric version "99"', function () {
            assert.strictEqual(util.isLegacyActionFormat(['99', 'TEST']), false);
        });
        it('should return true for tick name > 2 chars', function () {
            assert.strictEqual(util.isLegacyActionFormat(['TOKENNAME', '1000']), true);
        });
        it('should return true for non-numeric string', function () {
            assert.strictEqual(util.isLegacyActionFormat(['AB', '1000']), true);
        });
    });

    describe('getFormatVersion()', function () {
        it('should return 0 for undefined', function () {
            assert.strictEqual(util.getFormatVersion(undefined), 0);
        });
        it('should return 0 for empty string', function () {
            assert.strictEqual(util.getFormatVersion(''), 0);
        });
        it('should return integer for number input', function () {
            assert.strictEqual(util.getFormatVersion(5), 5);
        });
        it('should return integer for string number', function () {
            assert.strictEqual(util.getFormatVersion('3'), 3);
        });
        it('should accept 0', function () {
            assert.strictEqual(util.getFormatVersion(0), 0);
        });
        it('should accept 255', function () {
            assert.strictEqual(util.getFormatVersion(255), 255);
        });
        it('should return null for 256', function () {
            assert.strictEqual(util.getFormatVersion(256), null);
        });
        it('should return null for non-numeric string', function () {
            assert.strictEqual(util.getFormatVersion('abc'), null);
        });
        it('should return null for float', function () {
            assert.strictEqual(util.getFormatVersion(1.5), null);
        });
        it('should strip quotes from strings', function () {
            assert.strictEqual(util.getFormatVersion('"3"'), 3);
        });
    });
});

describe('Utility @regression @tier1', function () {
    beforeEach(freshUtil);

    describe('getFormatFieldList()', function () {
        it('should return unique list of fields from all formats', function () {
            const formats = {
                0: 'VERSION|TICK|AMOUNT',
                1: 'VERSION|TICK|DESCRIPTION',
            };
            const result = util.getFormatFieldList(formats);
            assert.deepStrictEqual(result, ['VERSION', 'TICK', 'AMOUNT', 'DESCRIPTION']);
        });
        it('should handle single format', function () {
            const formats = { 0: 'VERSION|TICK' };
            assert.deepStrictEqual(util.getFormatFieldList(formats), ['VERSION', 'TICK']);
        });
    });

    describe('setActionParams()', function () {
        it('should map params to fields based on format', function () {
            const formats = { 0: 'VERSION|TICK|AMOUNT' };
            const data = {};
            const result = util.setActionParams(data, ['0', 'TEST', '100'], formats, 0);
            assert.strictEqual(result.VERSION, '0');
            assert.strictEqual(result.TICK, 'TEST');
            assert.strictEqual(result.AMOUNT, '100');
        });
        it('should set missing params to null', function () {
            const formats = { 0: 'VERSION|TICK|AMOUNT|MEMO' };
            const data = {};
            const result = util.setActionParams(data, ['0', 'TEST'], formats, 0);
            assert.strictEqual(result.AMOUNT, null);
            assert.strictEqual(result.MEMO, null);
        });
        it('should set fields from other formats to null if not in current format', function () {
            const formats = {
                0: 'VERSION|TICK|AMOUNT',
                1: 'VERSION|TICK|DESCRIPTION',
            };
            const data = {};
            const result = util.setActionParams(data, ['0', 'TEST', '100'], formats, 0);
            assert.strictEqual(result.DESCRIPTION, null);
        });
        it('should trim param values', function () {
            const formats = { 0: 'VERSION|TICK' };
            const data = {};
            const result = util.setActionParams(data, ['0', '  TEST  '], formats, 0);
            assert.strictEqual(result.TICK, 'TEST');
        });
    });
});

describe('Utility @regression @tier1', function () {
    beforeEach(freshUtil);

    // ─── Balance & Ledger Helpers ─────────────────────────────────

    describe('hasBalance()', function () {
        it('should return true when balance >= amount', function () {
            assert.strictEqual(util.hasBalance({ 1: '100' }, 1, '50'), true);
        });
        it('should return true when balance == amount', function () {
            assert.strictEqual(util.hasBalance({ 1: '100' }, 1, '100'), true);
        });
        it('should return false when balance < amount', function () {
            assert.strictEqual(util.hasBalance({ 1: '50' }, 1, '100'), false);
        });
        it('should return false when tick_id not in balances', function () {
            assert.strictEqual(util.hasBalance({}, 1, '100'), false);
        });
        it('should handle high-precision amounts', function () {
            assert.strictEqual(util.hasBalance({ 1: '0.000000000000000001' }, 1, '0.000000000000000001'), true);
        });
    });

    describe('debitBalances()', function () {
        it('should subtract amount from balance', function () {
            const result = util.debitBalances({ 1: '100' }, 1, '30');
            assert.strictEqual(util.bcformat(result[1], 18), '70.000000000000000000');
        });
        it('should handle debit to zero', function () {
            const result = util.debitBalances({ 1: '100' }, 1, '100');
            assert.strictEqual(util.bcformat(result[1], 18), '0.000000000000000000');
        });
        it('should handle missing tick_id (treats as zero)', function () {
            const result = util.debitBalances({}, 1, '50');
            assert.strictEqual(util.bcformat(result[1], 18), '-50.000000000000000000');
        });
    });
});

describe('Utility @regression @tier1', function () {
    beforeEach(freshUtil);

    describe('consolidateLedgerRecords()', function () {
        it('should consolidate duplicate tick+address entries', function () {
            const records = [
                ['TICK1', '50', 'addr1'],
                ['TICK1', '30', 'addr1'],
            ];
            const result = util.consolidateLedgerRecords(records);
            assert.strictEqual(result.length, 1);
            assert.strictEqual(result[0][0], 'TICK1');
            assert.strictEqual(result[0][2], 'addr1');
            // 50 + 30 = 80
            assert.strictEqual(parseFloat(result[0][1].toString()), 80);
        });
        it('should keep different addresses separate', function () {
            const records = [
                ['TICK1', '50', 'addr1'],
                ['TICK1', '30', 'addr2'],
            ];
            const result = util.consolidateLedgerRecords(records);
            assert.strictEqual(result.length, 2);
        });
        it('should keep different ticks separate', function () {
            const records = [
                ['TICK1', '50', 'addr1'],
                ['TICK2', '30', 'addr1'],
            ];
            const result = util.consolidateLedgerRecords(records);
            assert.strictEqual(result.length, 2);
        });
        it('should return empty array for empty input', function () {
            assert.deepStrictEqual(util.consolidateLedgerRecords([]), []);
        });
        it('should return single record unchanged', function () {
            const records = [['TICK1', '50', 'addr1']];
            const result = util.consolidateLedgerRecords(records);
            assert.strictEqual(result.length, 1);
        });
    });
});
