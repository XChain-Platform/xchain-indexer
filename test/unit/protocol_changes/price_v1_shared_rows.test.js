'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const ProtocolChanges = require('../../../src/protocol_changes.js');
const priceScale = require('../../../src/consensus/gates/price_scale_gate.js');
const { priceV1Caps } = require('../actions/price/helpers/price_v1_caps.js');
const {
    isCanonicalV1ValueText,
    isCanonicalV1FeeText,
} = require('../actions/price/helpers/price_v1_canonical_oracle.js');
const { expectedPriceV1Rows } = require('./helpers/price_v1_expected_rows.js');

const FIXTURE = path.join(__dirname, '..', '..', 'fixtures', 'price_v1_length_measurement.json');
const KEYS = [
    'price_scale_activation.PRICE_V1_CANONICAL_ACTIVATION',
    'price_scale_activation.PRICE_V1_FEE_RE_CANONICAL',
    'price_scale_activation.PRICE_V1_VALUE_MAX_LENGTH',
    'price_scale_activation.PRICE_V1_FEE_MAX_LENGTH',
];

function loadMeasurement() {
    return JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
}

function actualRows() {
    return Object.fromEntries(KEYS.map((key) => [key, {
        kind: ProtocolChanges.registry.unitOf(key),
        value: ProtocolChanges.get(key),
    }]));
}

describe('PRICE v1 shared registry rows @regression @tier1', function () {
    const cases = [
        '', '0', '1', '0.01', '0012.5', '1.', '1.2.3', '-1', '1 ',
        '1234567890.12345678', '12345678901.12345678',
        '0.' + '1'.repeat(18), '0.' + '1'.repeat(19),
        null, undefined, 12,
    ];

    it('matches the four independently specified rows', function () {
        const caps = priceV1Caps(loadMeasurement());
        assert.deepStrictEqual(actualRows(), expectedPriceV1Rows(caps));
    });

    it('pins both length caps to the measured fixture', function () {
        const caps = priceV1Caps(loadMeasurement());
        assert.strictEqual(priceScale.PRICE_V1_VALUE_MAX_LENGTH, caps.value);
        assert.strictEqual(priceScale.PRICE_V1_FEE_MAX_LENGTH, caps.fee);
    });

    it('matches the independent VALUE and FEE oracles', function () {
        for (const value of cases) {
            assert.strictEqual(priceScale.isCanonicalPriceV1Value(value),
                isCanonicalV1ValueText(value, priceScale.PRICE_V1_VALUE_MAX_LENGTH),
                'VALUE ' + JSON.stringify(value));
            assert.strictEqual(priceScale.isCanonicalPriceV1Fee(value),
                isCanonicalV1FeeText(value, priceScale.PRICE_V1_FEE_MAX_LENGTH),
                'FEE ' + JSON.stringify(value));
        }
    });
});
