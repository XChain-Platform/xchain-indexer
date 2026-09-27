'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const { priceV1Caps } = require('./helpers/price_v1_caps');

const FIXTURE = path.join(__dirname, '..', '..', '..', 'fixtures', 'price_v1_length_measurement.json');

function load() {
    return JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
}

describe('PRICE v1 cap formula', function () {
    it('yields 19 and 20 over the landed fixture', function () {
        assert.deepStrictEqual(priceV1Caps(load()), { value: 19, fee: 20 });
    });

    it('raises the value cap to a longer canonical value', function () {
        const m = load();
        m.chains.DOGE.longest_canonical_value = 25;
        assert.deepStrictEqual(priceV1Caps(m), { value: 25, fee: 20 });
    });

    it('leaves the fee cap alone for a long non-canonical fee', function () {
        const m = load();
        m.chains.BTC.longest_valid_fee = 300;
        m.chains.BTC.longest_canonical_fee = 1;
        assert.strictEqual(priceV1Caps(m).fee, 20);
    });

    it('throws when a chain is missing', function () {
        const m = load();
        delete m.chains.TLTC;
        assert.throws(() => priceV1Caps(m), /TLTC/);
    });

    it('throws when a count is not a non-negative integer', function () {
        const m = load();
        m.chains.LTC.longest_canonical_fee = -1;
        assert.throws(() => priceV1Caps(m), /LTC/);
    });
});
