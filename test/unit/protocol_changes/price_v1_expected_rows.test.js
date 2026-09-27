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

// Pins expectedPriceV1Rows() against today's registry shape and the Design
// section 1 FEE pattern, so CBF-2 can pin its own rows against this helper
// without either side drifting first.

const assert = require('assert');
const { UNARMED } = require('../../../src/protocol_changes/core.js');
const ProtocolChanges = require('../../../src/protocol_changes.js');
const { expectedPriceV1Rows } = require('./helpers/price_v1_expected_rows.js');

const CAPS = { value: 19, fee: 20 };

const FEE_ACCEPT = ['0', '1', '0.01', '0.' + '1'.repeat(18)];
const FEE_REFUSE = ['00.5', '01', '.5', '1.', '0.' + '1'.repeat(19)];

describe('protocol_changes/helpers/price_v1_expected_rows @regression @tier1', function () {
    it('returns the four keys in order with their kinds and values', function () {
        const rows = expectedPriceV1Rows(CAPS);
        assert.deepStrictEqual(Object.keys(rows), [
            'price_scale_activation.PRICE_V1_CANONICAL_ACTIVATION',
            'price_scale_activation.PRICE_V1_FEE_RE_CANONICAL',
            'price_scale_activation.PRICE_V1_VALUE_MAX_LENGTH',
            'price_scale_activation.PRICE_V1_FEE_MAX_LENGTH',
        ]);
        assert.strictEqual(rows['price_scale_activation.PRICE_V1_CANONICAL_ACTIVATION'].kind, 'time');
        assert.strictEqual(rows['price_scale_activation.PRICE_V1_VALUE_MAX_LENGTH'].kind, 'constant');
        assert.strictEqual(rows['price_scale_activation.PRICE_V1_VALUE_MAX_LENGTH'].value, 19);
        assert.strictEqual(rows['price_scale_activation.PRICE_V1_FEE_MAX_LENGTH'].kind, 'constant');
        assert.strictEqual(rows['price_scale_activation.PRICE_V1_FEE_MAX_LENGTH'].value, 20);
    });

    it('arms the activation map mainnet and testnet slots to UNARMED, regtest at genesis', function () {
        const activation = expectedPriceV1Rows(CAPS)['price_scale_activation.PRICE_V1_CANONICAL_ACTIVATION'].value;
        assert.strictEqual(activation.mainnet, UNARMED);
        assert.strictEqual(activation.testnet, UNARMED);
        assert.strictEqual(activation.regtest, 0);
    });

    it('widens the canonical VALUE pattern to 18 decimals for FEE, unchanged otherwise', function () {
        const valueSource = ProtocolChanges.get('price_scale_activation.PRICE_VALUE_RE_CANONICAL').source;
        const feeRegex = expectedPriceV1Rows(CAPS)['price_scale_activation.PRICE_V1_FEE_RE_CANONICAL'].value;
        assert.strictEqual(feeRegex.source, valueSource.replace('{1,8}', '{1,18}'));
    });

    it('accepts and refuses the FEE regex boundary cases', function () {
        const feeRegex = expectedPriceV1Rows(CAPS)['price_scale_activation.PRICE_V1_FEE_RE_CANONICAL'].value;
        for (const text of FEE_ACCEPT) assert.ok(feeRegex.test(text), text + ' should be accepted');
        for (const text of FEE_REFUSE) assert.ok(!feeRegex.test(text), text + ' should be refused');
    });

    it('returns a fresh object on every call', function () {
        assert.notStrictEqual(expectedPriceV1Rows(CAPS), expectedPriceV1Rows(CAPS));
    });

    it('throws when a cap is not a positive safe integer', function () {
        for (const bad of [0, -1, 19.5, '19']) {
            assert.throws(() => expectedPriceV1Rows({ value: bad, fee: 20 }));
            assert.throws(() => expectedPriceV1Rows({ value: 19, fee: bad }));
        }
    });
});
