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
// test/unit/actions/price_zero_validity.test.js
//
// PRICE price-RANGE flag day, chain side.
//
// The hub refuses any pair price not strictly inside (0, PRICE_MAX) at all three
// of its ingest points; the chain checked only the decimal pattern. So a
// quorum-signed '0' or at-ceiling price was CHAIN-VALID and HUB-INVALID, and
// because one signature set covers a whole batch window, the hub threw away the
// entire hour of prices the round rode in without a word.
//
// What this suite pins is AGREEMENT, not the presence of a check: the hub's own
// admission expression is transcribed here as the reference oracle and the
// chain's verdict is compared against it on both sides of both bounds, including
// the value where the transcription is surprising ('9999999999.99999999', the
// widest string the scale rule admits, which parseFloat rounds up to exactly
// PRICE_MAX and the hub therefore refuses). Both sides of the gate are driven
// through the REAL parser on a real signed batch, because the claim that matters
// is not "a check exists" but "a replay below the flag day reaches the same
// verdict it reaches today".
//
// This entry holds the shipped-posture cases. The hub-agreement, batch-parser
// and v1 cases live beside it in price_zero_validity.test/, opening the same
// 'PRICE price-range flag day @regression @tier3' describe so every full test
// title is unchanged; price_zero_validity.test/helpers/price_range_harness.js
// holds the hub oracle, the value table, the wire builders and the mock harness.

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');

const priceRange = require('../../../src/actions/price/price_zero_validity_gate.js');

const {
    TESTNET_GATE, usePriceRangeHarness,
} = require('./price_zero_validity.test/helpers/price_range_harness.js');

// -----------------------------------------------------------------------
// The shipped map, evaluated with no stub in sight.
// -----------------------------------------------------------------------
describe('PRICE price-range flag day @regression @tier3', function () {
    usePriceRangeHarness();

    describe('the posture this node ships', function () {

        it('leaves mainnet inert at every instant, so the legacy path runs byte for byte', function () {
            assert.strictEqual(priceRange.PRICE_ZERO_VALIDITY_ACTIVATION.mainnet, null);
            for(const t of [0, 1, 1700000000, 4000000000])
                assert.strictEqual(priceRange.isPriceZeroValidityActive(t, 'mainnet'), false, 'mainnet t=' + t);
        });

        it('arms testnet at its instant and not one second earlier', function () {
            assert.ok(Number.isFinite(TESTNET_GATE) && TESTNET_GATE > 0);
            assert.strictEqual(priceRange.isPriceZeroValidityActive(TESTNET_GATE - 1, 'testnet'), false);
            assert.strictEqual(priceRange.isPriceZeroValidityActive(TESTNET_GATE, 'testnet'), true);
            assert.strictEqual(priceRange.isPriceZeroValidityActive(TESTNET_GATE + 1, 'testnet'), true);
            // Sized with headroom: the instant must still be ahead of the tree's own
            // build time, or it shipped already armed with no deploy wave behind it.
            assert.ok(TESTNET_GATE > 1789000000, 'the testnet instant must be sized in the future');
        });

        it('arms regtest from genesis so the oracle venue exercises the armed rule', function () {
            assert.strictEqual(priceRange.PRICE_ZERO_VALIDITY_ACTIVATION.regtest, 0);
            assert.strictEqual(priceRange.isPriceZeroValidityActive(0, 'regtest'), true);
            assert.strictEqual(priceRange.isPriceZeroValidityActive(1700000000, 'regtest'), true);
        });

        it('fails CLOSED on an unusable key, leaving the legacy behaviour', function () {
            // An unknown network, and every empty-ish block time that Number() would
            // otherwise map to a perfectly finite 0 and read as armed on regtest.
            assert.strictEqual(priceRange.isPriceZeroValidityActive(0, 'signet'), false);
            for(const t of [null, undefined, '', false, true, 'abc', NaN])
                assert.strictEqual(priceRange.isPriceZeroValidityActive(t, 'regtest'), false,
                    'block time ' + String(t) + ' must fail closed');
            // Failing closed means NO range test, i.e. the value is admitted.
            assert.strictEqual(priceRange.isPriceRangeValid('0', null, 'regtest'), true);
            assert.strictEqual(priceRange.isPriceRangeValid('0', 1700000000, 'mainnet'), true);
        });
    });
});
