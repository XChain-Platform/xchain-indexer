'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer } = require('../../../fixtures/mocks');

// ---------------------------------------------------------------------------
// Suite: balance and arithmetic integrity
// ---------------------------------------------------------------------------

describe('Security: balance integrity and adversarial arithmetic @regression @tier4', function () {
    let util;

    before(function () {
        const indexer = createMockIndexer();
        util = indexer.util;
    });

    // -----------------------------------------------------------------------
    // hasBalance
    // -----------------------------------------------------------------------

    it('SEC-29: hasBalance({1: \'100\'}, 1, \'50\') → true (normal case)', function () {
        assert.strictEqual(util.hasBalance({ 1: '100' }, 1, '50'), true);
    });

    it('SEC-30: hasBalance({1: \'100\'}, 1, \'200\') → false (insufficient)', function () {
        assert.strictEqual(util.hasBalance({ 1: '100' }, 1, '200'), false);
    });

    it('SEC-31: hasBalance({}, 1, \'100\') → false (no balance entry)', function () {
        assert.strictEqual(util.hasBalance({}, 1, '100'), false);
    });

    // -----------------------------------------------------------------------
    // debitBalances
    // -----------------------------------------------------------------------

    it('SEC-32: debitBalances({1: \'100\'}, 1, \'50\') → balance = 50', function () {
        const result = util.debitBalances({ 1: '100' }, 1, '50');
        assert.strictEqual(util.bcformat(result[1], 18), '50.000000000000000000');
    });

    // -----------------------------------------------------------------------
    // bcsub edge cases
    // -----------------------------------------------------------------------

    it('SEC-33: bcsub(\'100\', \'200\', 18) → negative result (documented behavior)', function () {
        const result = util.bcsub('100', '200', 18);
        // Result should be -100 — bcsub does not prevent negative results
        assert.strictEqual(util.bcformat(result, 18), '-100.000000000000000000');
    });

    // -----------------------------------------------------------------------
    // Large number precision
    // -----------------------------------------------------------------------

    it('SEC-34: bcadd with very large numbers → no precision loss', function () {
        const a = '99999999999999999999';
        const b = '1';
        const result = util.bcadd(a, b, 0);
        assert.strictEqual(util.bcformat(result, 0), '100000000000000000000');
    });

    // -----------------------------------------------------------------------
    // Negative string in bcsub (documents the pre-fix vulnerability)
    // -----------------------------------------------------------------------

    it('SEC-35: bcsub(\'100\', \'-100\', 18) → 200 (subtracting negative adds)', function () {
        // This documents why the isValidAmountFormat fix is critical:
        // If a negative amount reaches bcsub as the second argument, it ADDS instead of subtracts
        const result = util.bcsub('100', '-100', 18);
        assert.strictEqual(util.bcformat(result, 18), '200.000000000000000000',
            'subtracting a negative number adds — this is why input validation must reject negatives');
    });

    // -----------------------------------------------------------------------
    // Consolidated ledger records
    // -----------------------------------------------------------------------

    it('SEC-36: consolidateLedgerRecords with mixed amounts → correct aggregation', function () {
        const records = [
            ['TEST', '100', 'addr1'],
            ['TEST', '50', 'addr1'],
            ['TEST', '25', 'addr2'],
        ];
        const result = util.consolidateLedgerRecords(records);
        // addr1 should have 150, addr2 should have 25
        let addr1Amount, addr2Amount;
        for (const [tick, amount, address] of result) {
            if (address === 'addr1') addr1Amount = util.bcformat(amount, 18);
            if (address === 'addr2') addr2Amount = util.bcformat(amount, 18);
        }
        assert.strictEqual(addr1Amount, '150.000000000000000000');
        assert.strictEqual(addr2Amount, '25.000000000000000000');
    });
});
