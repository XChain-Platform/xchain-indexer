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

const { createMockIndexer } = require('../../fixtures/mocks');

describe('Smoke: utility math and validation', function () {

    let util;

    before(function () {
        // createMockIndexer() builds a real Utility instance via new Utility()
        const indexer = createMockIndexer();
        util = indexer.util;
    });

    afterEach(function () {
        sinon.restore();
    });

    it('SM-13: Core math functions produce correct results', function () {

        // ── Arithmetic ────────────────────────────────────────────────────
        // bcadd/bcsub/bcmul/bcdiv return mathjs BigNumber objects;
        // use bcformat() to render them as fixed-decimal strings.
        assert.strictEqual(util.bcformat(util.bcadd('1.5', '2.5', 8), 8),  '4.00000000',  'bcadd 1.5 + 2.5');
        assert.strictEqual(util.bcformat(util.bcsub('100', '99.5', 8), 8), '0.50000000',  'bcsub 100 - 99.5');
        assert.strictEqual(util.bcformat(util.bcmul('2', '3.5', 8), 8),    '7.00000000',  'bcmul 2 × 3.5');
        assert.strictEqual(util.bcformat(util.bcdiv('10', '3', 8), 8),     '3.33333333',  'bcdiv 10 ÷ 3');

        // ── Comparisons ───────────────────────────────────────────────────
        assert.strictEqual(util.bcgt('10', '9'),   true,  'bcgt 10 > 9');
        assert.strictEqual(util.bcgt('9', '10'),   false, 'bcgt 9 > 10 is false');
        assert.strictEqual(util.bclt('5', '10'),   true,  'bclt 5 < 10');
        assert.strictEqual(util.bcgte('10', '10'), true,  'bcgte 10 >= 10');
        assert.strictEqual(util.bclte('10', '10'), true,  'bclte 10 <= 10');

        // ── High-precision drain-to-zero ──────────────────────────────────
        assert.strictEqual(
            util.bcformat(util.bcsub('100', '100', 18), 18),
            '0.000000000000000000',
            'bcsub drain-to-zero with 18 decimals'
        );

        // ── isNumeric ─────────────────────────────────────────────────────
        assert.strictEqual(util.isNumeric('123'), true,  'isNumeric numeric string');
        assert.strictEqual(util.isNumeric('abc'), false, 'isNumeric alpha string');

        // ── isNull ────────────────────────────────────────────────────────
        assert.strictEqual(util.isNull(null),    true,  'isNull null');
        assert.strictEqual(util.isNull(''),      true,  'isNull empty string');
        assert.strictEqual(util.isNull('value'), false, 'isNull non-empty string');

        // ── isCryptoAddress ───────────────────────────────────────────────
        // Valid regtest P2PKH (base58check checksum + version byte)
        assert.strictEqual(util.isCryptoAddress('mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH'), true,  'isCryptoAddress valid P2PKH');
        // Address-length garbage fails the checksum
        assert.strictEqual(util.isCryptoAddress('A'.repeat(34)), false, 'isCryptoAddress 34-char garbage invalid');
        // 20-char string is too short
        assert.strictEqual(util.isCryptoAddress('A'.repeat(20)), false, 'isCryptoAddress 20-char too short');
    });

});
