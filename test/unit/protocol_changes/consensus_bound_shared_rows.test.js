'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ProtocolChanges = require('../../../src/protocol_changes.js');
const gateRegistry = require('../../../src/consensus/gate_registry');
const priceScale = require('../../../src/consensus/gates/price_scale_gate.js');
const { SHARED_GATES } = require('../../../src/consensus_rules_digest');
const { priceV1Caps } = require('../actions/price/helpers/price_v1_caps.js');
const { expectedPriceV1Rows } = require('./helpers/price_v1_expected_rows.js');

const SHARED_ROWS_DIR = path.join(__dirname, '..', '..', '..', 'src', 'protocol_changes');
const PRICE_V1_FIXTURE = path.join(__dirname, '..', '..', 'fixtures', 'price_v1_length_measurement.json');
const PRICE_V1_KEYS = [
    'price_scale_activation.PRICE_V1_CANONICAL_ACTIVATION',
    'price_scale_activation.PRICE_V1_FEE_RE_CANONICAL',
    'price_scale_activation.PRICE_V1_VALUE_MAX_LENGTH',
    'price_scale_activation.PRICE_V1_FEE_MAX_LENGTH',
];

describe('protocol_changes consensus-bound shared rows', function () {
    it('keeps the first three shared row parts at or under 400 lines', function () {
        for (const name of ['shared_rows_1.js', 'shared_rows_2.js', 'shared_rows_3.js']) {
            const text = fs.readFileSync(path.join(SHARED_ROWS_DIR, name), 'utf8');
            const lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
            assert.ok(lines <= 400, name + ' is ' + lines + ' lines');
        }
    });

    it('holds the anchor bundle order entry exactly once', function () {
        const entries = SHARED_GATES.filter(([stem, names]) =>
            stem === 'anchor_bundle_order_activation' &&
            names.length === 1 && names[0] === 'ANCHOR_BUNDLE_ORDER_ACTIVATION');
        assert.deepStrictEqual(entries, [
            ['anchor_bundle_order_activation', ['ANCHOR_BUNDLE_ORDER_ACTIVATION']],
        ]);
    });

    it('keeps the PRICE v1 canonical bounds last in the shared digest', function () {
        assert.deepStrictEqual(SHARED_GATES[SHARED_GATES.length - 1], [
            'price_scale_activation',
            ['PRICE_V1_CANONICAL_ACTIVATION', 'PRICE_V1_VALUE_MAX_LENGTH', 'PRICE_V1_FEE_MAX_LENGTH'],
        ]);
    });

    it('resolves the existing price scale rows through the gate registry', function () {
        const names = [
            'PRICE_SCALE_ACTIVATION',
            'PRICE_SCALE_MAX_DECIMALS',
            'PRICE_VALUE_RE_LEGACY',
            'PRICE_VALUE_RE_CANONICAL',
        ];
        for (const name of names) {
            const key = 'price_scale_activation.' + name;
            assert.notStrictEqual(gateRegistry.get(key), undefined, key + ' did not resolve');
        }
    });

    it('registers the four PRICE v1 rows with the measured caps', function () {
        const fixture = JSON.parse(fs.readFileSync(PRICE_V1_FIXTURE, 'utf8'));
        const expected = expectedPriceV1Rows(priceV1Caps(fixture));
        const actual = Object.fromEntries(PRICE_V1_KEYS.map((key) => [key, {
            kind: ProtocolChanges.registry.unitOf(key),
            value: ProtocolChanges.get(key),
        }]));
        assert.strictEqual(fixture.read_at, '2026-09-25T21:52:09.659Z');
        assert.deepStrictEqual(actual, expected);
        assert.strictEqual(priceScale.PRICE_V1_VALUE_MAX_LENGTH, 19);
        assert.strictEqual(priceScale.PRICE_V1_FEE_MAX_LENGTH, 20);
    });

    it('exports the PRICE v1 activation and canonical predicates', function () {
        assert.strictEqual(priceScale.isPriceV1CanonicalActive(0, 'regtest'), true);
        assert.strictEqual(priceScale.isPriceV1CanonicalActive(0, 'mainnet'), false);
        assert.strictEqual(priceScale.isCanonicalPriceV1Value('9999999999.12345678'), true);
        assert.strictEqual(priceScale.isCanonicalPriceV1Value('99999999999.12345678'), false);
        assert.strictEqual(priceScale.isCanonicalPriceV1Fee('0.' + '1'.repeat(18)), true);
        assert.strictEqual(priceScale.isCanonicalPriceV1Fee('0.' + '1'.repeat(19)), false);
    });
});
