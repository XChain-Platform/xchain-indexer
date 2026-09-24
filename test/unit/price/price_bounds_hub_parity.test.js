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
// test/unit/price/price_bounds_hub_parity.test.js
//
// PRICE price-bounds hub parity: the indexer's (0, PRICE_MAX) gate, pinned
// against the hub's own admission expression rather than against a
// transcription nobody re-checks.
//
// This is a validity change with its own activation
// (price_zero_validity_gate.js's PRICE_ZERO_VALIDITY_ACTIVATION), not a
// silent tightening of the decimal-shape check that already ran: below the
// gate every price the legacy pattern admitted stays admissible, so a
// from-genesis replay is byte-identical, and only at and above it does the
// chain converge onto the hub's bound.

'use strict';

const assert = require('assert');
const path   = require('path');

const priceRange = require('../../../src/actions/price/price_zero_validity_gate.js');
const { siblingCheckout, skipOrFail } = require('../../helpers/sibling_checkout.js');
const { readSiblingModuleSource } = require('../../helpers/sibling_module_source.js');

// The hub's admission predicate, transcribed from PriceAggregator's ingest
// sites: `!(parseFloat(String(p.price)) > 0) || !(parseFloat(String(p.price)) < PRICE_MAX)`
// refuses. Written out rather than required so this suite needs no hub
// checkout to grade the chain's verdict against it; the drift alarm below
// re-reads the hub source when a sibling checkout is present and usable.
const HUB_PRICE_MAX = 10000000000;
function hubAdmits(price){
    let p = parseFloat(String(price));
    if(!(p > 0))             return false;
    if(!(p < HUB_PRICE_MAX)) return false;
    return true;
}

// Values spanning both bounds and the near-miss on each side, including the
// widest canonical string ('9999999999.99999999'), which parseFloat rounds
// UP to exactly the ceiling: the hub refuses it and, because agreement with
// the hub's double comparison is the requirement here rather than exact
// math, so must the chain.
const RANGE_CASES = [
    '0',
    '0.00000000',
    '0.00000001',
    '1',
    '50000.00000000',
    '9999999999',
    '9999999999.999',
    '9999999999.99999998',
    '9999999999.99999999',
    '10000000000',
    '10000000000.00000000',
    '99999999999999999999',
];

const TESTNET_GATE = priceRange.PRICE_ZERO_VALIDITY_ACTIVATION.testnet;

describe('PRICE price-bounds hub parity @regression @tier3', function () {

    it('reads the same ceiling the hub reads', function () {
        assert.strictEqual(priceRange.PRICE_MAX, HUB_PRICE_MAX);
    });

    it('matches the hub verdict on every case, both sides of both bounds', function () {
        // At least one case must land on each side, or a predicate that
        // answered a constant would pass this table.
        let admitted = 0, refused = 0;
        for(const price of RANGE_CASES){
            const expected = hubAdmits(price);
            assert.strictEqual(priceRange.isPriceInHubRange(price), expected,
                'price ' + price + ' must be ' + (expected ? 'admitted' : 'refused'));
            expected ? admitted++ : refused++;
        }
        assert.ok(admitted >= 4 && refused >= 4, 'the table must exercise both verdicts');
    });

    it('is a validity change with its own activation, not a silent tightening', function () {
        // Below the flag day, a price the legacy decimal-shape check admitted
        // stays admissible even though it sits outside the hub's own range,
        // which is what keeps a from-genesis replay byte-identical.
        assert.strictEqual(priceRange.isPriceRangeValid('0', TESTNET_GATE - 1, 'testnet'), true);
        assert.strictEqual(priceRange.isPriceRangeValid('10000000000', TESTNET_GATE - 1, 'testnet'), true);
        assert.strictEqual(priceRange.isPriceRangeValid('99999999999999999999', TESTNET_GATE - 1, 'testnet'), true);

        // At and above it, the chain converges onto the same bound the hub
        // enforces: the same out-of-range values now refuse, and a value the
        // hub would have admitted still does.
        assert.strictEqual(priceRange.isPriceRangeValid('0', TESTNET_GATE, 'testnet'), false);
        assert.strictEqual(priceRange.isPriceRangeValid('10000000000', TESTNET_GATE, 'testnet'), false);
        assert.strictEqual(priceRange.isPriceRangeValid('50000.00000000', TESTNET_GATE, 'testnet'), true);

        // The inert sentinel (mainnet, null) never arms: no range test runs.
        assert.strictEqual(priceRange.PRICE_ZERO_VALIDITY_ACTIVATION.mainnet, null);
        assert.strictEqual(priceRange.isPriceRangeValid('0', TESTNET_GATE, 'mainnet'), true);
    });

    it('refuses an unparseable value at both ends rather than admitting NaN', function () {
        for(const price of ['', 'abc', 'NaN', undefined, null, {}])
            assert.strictEqual(priceRange.isPriceInHubRange(price), false, String(price));
    });

    it('still carries the same expression the hub carries, when the hub tree is present', function () {
        // Drift alarm rather than the oracle: the transcription above is what
        // grades every case above, and this re-reads the hub source when a
        // sibling checkout exists and may be trusted (see sibling_checkout.js
        // for why a lane symlink into a live main checkout is refused like an
        // absent hub rather than trusted).
        const hubSrc = path.join(__dirname, '..', '..', '..', '..', 'xchain-hub', 'src', 'oracle', 'price_aggregator.js');
        const hubCheckout = siblingCheckout(__dirname, hubSrc);
        if(!hubCheckout.usable) return skipOrFail(this, hubCheckout, 'the hub price_aggregator drift alarm');

        // The aggregator's two v0 ingest sites live in its part files
        // (price_aggregator/round_validation.js and batch_validation.js)
        // while the entry keeps the path this alarm names, so the module is
        // read whole; reading the entry alone would count zero sites and
        // read as hub drift the hub never had.
        const text  = readSiblingModuleSource(hubSrc);
        const lower = /!\(parseFloat\(String\(p\.price\)\) > 0\)/g;
        const upper = /!\(parseFloat\(String\(p\.price\)\) < PRICE_MAX\)/g;
        assert.strictEqual((text.match(lower) || []).length, 2,
            'both hub v0 ingest sites must still carry the transcribed lower bound');
        assert.strictEqual((text.match(upper) || []).length, 2,
            'both hub v0 ingest sites must still carry the transcribed upper bound');
    });
});
