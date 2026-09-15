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
// This file holds the shipped-posture and hub-agreement cases (the hub drift
// alarm reads the hub tree relative to this file). The batch-parser and v1
// cases live beside it in price_zero_validity.test/, opening the same
// 'PRICE price-range flag day @regression @tier3' describe so every full test
// title is unchanged; price_zero_validity.test/helpers/price_range_harness.js
// holds the hub oracle, the value table, the wire builders and the mock harness.

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const priceRange = require('../../../src/price_zero_validity_activation.js');
// Decides whether the hub aggregator source may be trusted before the drift alarm reads it.
const { siblingCheckout, skipOrFail } = require('../../helpers/sibling_checkout.js');
const { readSiblingModuleSource } = require('../../helpers/sibling_module_source.js');

const {
    HUB_PRICE_MAX, hubAdmits, RANGE_CASES, TESTNET_GATE, usePriceRangeHarness,
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

// -----------------------------------------------------------------------
// Agreement with the hub, value by value.
// -----------------------------------------------------------------------
describe('PRICE price-range flag day @regression @tier3', function () {
    usePriceRangeHarness();

    describe('agreement with the hub bound', function () {

        it('reads the same ceiling the hub reads', function () {
            assert.strictEqual(priceRange.PRICE_MAX, HUB_PRICE_MAX);
        });

        it('matches the hub verdict on every case, both sides of both bounds', function () {
            // At least one case must land on each side, or a predicate that answered a
            // constant would pass this table.
            let admitted = 0, refused = 0;
            for(const price of RANGE_CASES){
                const expected = hubAdmits(price);
                assert.strictEqual(priceRange.isPriceInHubRange(price), expected,
                    'price ' + price + ' must be ' + (expected ? 'admitted' : 'refused'));
                expected ? admitted++ : refused++;
            }
            assert.ok(admitted >= 4 && refused >= 4, 'the table must exercise both verdicts');
        });

        it('refuses the widest canonical string, because the hub does', function () {
            // 9999999999.99999999 is 19 characters and scale-legal, but an ulp near 1e10
            // is 1.907e-6, so parseFloat rounds to exactly PRICE_MAX every value within
            // half of that (about 9.5e-7) of the ceiling. Exact math would ADMIT them
            // here and hand the hub rounds it discards, which is this item's defect with
            // a smaller footprint. Agreement is the requirement, so the chain refuses
            // the same top sliver of the range the hub refuses, and admits the rest.
            for(const price of ['9999999999.99999999', '9999999999.99999998', '9999999999.9999999'])
                assert.strictEqual(priceRange.isPriceInHubRange(price), false, price);
            for(const price of ['9999999999.999999', '9999999999.999'])
                assert.strictEqual(priceRange.isPriceInHubRange(price), true, price);
            assert.strictEqual(priceRange.isPriceInHubRange('9999999999'), true);
        });

        it('refuses an unparseable value at both ends rather than admitting NaN', function () {
            for(const price of ['', 'abc', 'NaN', undefined, null, {}])
                assert.strictEqual(priceRange.isPriceInHubRange(price), false, String(price));
        });

        it('still carries the same expression the hub carries, when the hub tree is present', function () {
            // Drift alarm rather than the oracle: the transcription above is what grades
            // every case, and this re-reads the hub source when a sibling checkout exists.
            const hubSrc = path.join(__dirname, '..', '..', '..', '..', 'xchain-hub', 'src', 'oracle', 'price_aggregator.js');
            // A lane symlink into a live main checkout is refused like an absent hub.
            const hubCheckout = siblingCheckout(__dirname, hubSrc);
            if(!hubCheckout.usable) return skipOrFail(this, hubCheckout, 'the hub price_aggregator drift alarm');
            // The aggregator's two v0 ingest sites live in its part files
            // (price_aggregator/round_validation.js and batch_validation.js) while the
            // entry keeps the path this alarm names, so the module is read whole. Reading
            // the entry alone counts zero sites and reads as hub drift the hub never had.
            const text = readSiblingModuleSource(hubSrc);
            const lower = /!\(parseFloat\(String\(p\.price\)\) > 0\)/g;
            const upper = /!\(parseFloat\(String\(p\.price\)\) < PRICE_MAX\)/g;
            assert.strictEqual((text.match(lower) || []).length, 2,
                'both hub v0 ingest sites must still carry the transcribed lower bound');
            assert.strictEqual((text.match(upper) || []).length, 2,
                'both hub v0 ingest sites must still carry the transcribed upper bound');
        });
    });
});
