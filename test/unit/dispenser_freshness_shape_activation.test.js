/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/dispenser_freshness_shape_activation.test.js
 *
 * DISPENSER fresh-address oracle-shape flag-day. At/after the gate a
 * shape-violating non-null get_first_seen answer throws (fail closed) instead of
 * reading as "never appeared on chain" (fail open). These cases pin the predicate
 * both sides of the gate: mainnet unarmed at every height, testnet + regtest
 * genesis-active, unknown network and unusable height off, and the coin-qualified
 * key taking precedence over the bare network key.
 */

'use strict';

const assert = require('assert');
const { isDispenserFreshnessShapeStrict, DISPENSER_FRESHNESS_SHAPE_ACTIVATION } =
    require('../../src/dispenser_freshness_shape_activation.js');

describe('dispenser freshness oracle-shape activation predicate @regression @tier1', function () {

    // The whole point of shipping unarmed: no mainnet DISPENSER already in hashed
    // history changes verdict, at any height, on any coin of the train.
    it('mainnet is UNARMED for every coin at every height', function () {
        for (const coin of ['BTC', 'LTC', 'DOGE']) {
            assert.strictEqual(isDispenserFreshnessShapeStrict(0, 'mainnet', coin), false);
            assert.strictEqual(isDispenserFreshnessShapeStrict(500000, 'mainnet', coin), false);
            assert.strictEqual(isDispenserFreshnessShapeStrict(961000, 'mainnet', coin), false);
            assert.strictEqual(isDispenserFreshnessShapeStrict(999999999, 'mainnet', coin), false);
        }
        // A coin outside the train inherits the bare-mainnet null, not an armed default.
        assert.strictEqual(isDispenserFreshnessShapeStrict(500000, 'mainnet', 'BCH'), false);
        assert.strictEqual(isDispenserFreshnessShapeStrict(500000, 'mainnet', null), false);
    });

    it('testnet is genesis-active for every coin', function () {
        assert.strictEqual(isDispenserFreshnessShapeStrict(0, 'testnet', 'BTC'), true);
        assert.strictEqual(isDispenserFreshnessShapeStrict(0, 'testnet', 'DOGE'), true);
        assert.strictEqual(isDispenserFreshnessShapeStrict(999999999, 'testnet', 'LTC'), true);
    });

    it('regtest is genesis-active at any block height', function () {
        assert.strictEqual(isDispenserFreshnessShapeStrict(0, 'regtest', 'BTC'), true);
        assert.strictEqual(isDispenserFreshnessShapeStrict(999999999, 'regtest', 'DOGE'), true);
    });

    it('unknown network or unusable height is off (legacy fail-open null preserved)', function () {
        assert.strictEqual(isDispenserFreshnessShapeStrict(0, 'stagenet', 'BTC'), false);
        assert.strictEqual(isDispenserFreshnessShapeStrict(0, undefined, 'BTC'), false);
        assert.strictEqual(isDispenserFreshnessShapeStrict('nonsense', 'regtest', 'BTC'), false);
        assert.strictEqual(isDispenserFreshnessShapeStrict(undefined, 'regtest', 'BTC'), false);
        assert.strictEqual(isDispenserFreshnessShapeStrict(null, 'regtest', 'BTC'), false);
    });

    // `b >= null` coerces to `b >= 0`, so a missing explicit null test arms the flip
    // on every block of an unratified chain. This case is that coercion's tripwire:
    // it reads the sentinel straight off the map rather than trusting the value above.
    it('the null sentinel reads as off, never as height 0', function () {
        assert.strictEqual(DISPENSER_FRESHNESS_SHAPE_ACTIVATION['BTC:mainnet'], null);
        assert.strictEqual(DISPENSER_FRESHNESS_SHAPE_ACTIVATION.mainnet, null);
        assert.strictEqual(isDispenserFreshnessShapeStrict(0, 'mainnet', 'BTC'), false);
    });

    it('the coin-qualified key wins over the bare network key', function () {
        const map  = DISPENSER_FRESHNESS_SHAPE_ACTIVATION;
        const orig = Object.getOwnPropertyDescriptor(map, 'BTC:regtest');
        map['BTC:regtest'] = 400;
        try {
            // regtest is 0 on the bare key, so a coin-qualified 400 can only be visible
            // if the qualified lookup is consulted first.
            assert.strictEqual(isDispenserFreshnessShapeStrict(399, 'regtest', 'BTC'), false);
            assert.strictEqual(isDispenserFreshnessShapeStrict(400, 'regtest', 'BTC'), true);
            assert.strictEqual(isDispenserFreshnessShapeStrict(399, 'regtest', 'DOGE'), true);
        } finally {
            if (orig) Object.defineProperty(map, 'BTC:regtest', orig);
            else delete map['BTC:regtest'];
        }
    });

    it('an armed threshold is a boundary, inert one block below it', function () {
        const map  = DISPENSER_FRESHNESS_SHAPE_ACTIVATION;
        const orig = Object.getOwnPropertyDescriptor(map, 'BTC:mainnet');
        map['BTC:mainnet'] = 960000;
        try {
            assert.strictEqual(isDispenserFreshnessShapeStrict(959999, 'mainnet', 'BTC'), false);
            assert.strictEqual(isDispenserFreshnessShapeStrict(960000, 'mainnet', 'BTC'), true);
            assert.strictEqual(isDispenserFreshnessShapeStrict(960001, 'mainnet', 'BTC'), true);
            // A sibling coin is unaffected by one coin arming.
            assert.strictEqual(isDispenserFreshnessShapeStrict(960000, 'mainnet', 'LTC'), false);
        } finally {
            Object.defineProperty(map, 'BTC:mainnet', orig);
        }
    });
});
