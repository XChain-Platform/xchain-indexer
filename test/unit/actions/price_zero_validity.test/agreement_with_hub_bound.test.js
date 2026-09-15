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
// PRICE price-range flag day against the hub's own bound: the chain's range
// predicate agrees with the transcribed hub oracle value by value, and a drift
// alarm re-reads the hub aggregator source when a sibling checkout is present.
// Part of the PRICE price-range suite; see ../price_zero_validity.test.js.

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const path   = require('path');

const priceRange = require('../../../../src/price_zero_validity_activation.js');
// Decides whether the hub aggregator source may be trusted before the drift alarm reads it.
const { siblingCheckout, skipOrFail } = require('../../../helpers/sibling_checkout.js');
const { readSiblingModuleSource } = require('../../../helpers/sibling_module_source.js');

const {
    HUB_PRICE_MAX, hubAdmits, RANGE_CASES, usePriceRangeHarness,
} = require('./helpers/price_range_harness.js');

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
    });
});

// The drift alarm, in its own same-title block so the value-by-value cases
// above stay within the function length limit; the harness hook is per test,
// so this test runs under exactly the setup it had.
describe('PRICE price-range flag day @regression @tier3', function () {
    usePriceRangeHarness();

    describe('agreement with the hub bound', function () {

        it('still carries the same expression the hub carries, when the hub tree is present', function () {
            // Drift alarm rather than the oracle: the transcription above is what grades
            // every case, and this re-reads the hub source when a sibling checkout exists.
            const hubSrc = path.join(__dirname, '..', '..', '..', '..', '..', 'xchain-hub', 'src', 'oracle', 'price_aggregator.js');
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
