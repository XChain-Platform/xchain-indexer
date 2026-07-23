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
 * test/unit/dispenser_freshness_activation.test.js
 *
 * DISPENSER fresh-address verdict causality flag-day ( / b7ecae51). The
 * verdict switches from the external utxo-tracker getFirstSeen HTTP call to
 * deterministic indexer-local chain state at the ratified deploy-train heights.
 * These tests pin the activation-module predicate both sides of the gate: mainnet
 * per-coin boundary, testnet + regtest genesis, unknown/bad input off.
 */

'use strict';

const assert = require('assert');
const { isDispenserFreshnessLocalActive, DISPENSER_FRESHNESS_ACTIVATION } =
    require('../../src/dispenser_freshness_activation.js');

describe('dispenser freshness activation predicate  @regression @tier1', function () {

    it('mainnet is armed per coin: inert below the height, active at/after it', function () {
        assert.strictEqual(isDispenserFreshnessLocalActive(960999, 'mainnet', 'BTC'), false);
        assert.strictEqual(isDispenserFreshnessLocalActive(961000, 'mainnet', 'BTC'), true);
        assert.strictEqual(isDispenserFreshnessLocalActive(3154249, 'mainnet', 'LTC'), false);
        assert.strictEqual(isDispenserFreshnessLocalActive(3154250, 'mainnet', 'LTC'), true);
        assert.strictEqual(isDispenserFreshnessLocalActive(6318999, 'mainnet', 'DOGE'), false);
        assert.strictEqual(isDispenserFreshnessLocalActive(6319000, 'mainnet', 'DOGE'), true);
    });

    it('testnet is genesis-active for every coin (pre-launch cohort)', function () {
        assert.strictEqual(isDispenserFreshnessLocalActive(0, 'testnet', 'BTC'), true);
        assert.strictEqual(isDispenserFreshnessLocalActive(0, 'testnet', 'DOGE'), true);
        assert.strictEqual(isDispenserFreshnessLocalActive(999999999, 'testnet', 'LTC'), true);
    });

    it('regtest is genesis-active at any block height', function () {
        assert.strictEqual(isDispenserFreshnessLocalActive(0, 'regtest', 'BTC'), true);
        assert.strictEqual(isDispenserFreshnessLocalActive(999999999, 'regtest', 'DOGE'), true);
    });

    it('unknown network or unparseable height is off (safe: keeps legacy tracker path)', function () {
        assert.strictEqual(isDispenserFreshnessLocalActive(0, 'stagenet', 'BTC'), false);
        assert.strictEqual(isDispenserFreshnessLocalActive('nonsense', 'regtest', 'BTC'), false);
        assert.strictEqual(isDispenserFreshnessLocalActive(undefined, 'mainnet', 'BTC'), false);
    });

    it('the ratified per-coin train heights are pinned in the map', function () {
        assert.strictEqual(DISPENSER_FRESHNESS_ACTIVATION['BTC:mainnet'], 961000);
        assert.strictEqual(DISPENSER_FRESHNESS_ACTIVATION['LTC:mainnet'], 3154250);
        assert.strictEqual(DISPENSER_FRESHNESS_ACTIVATION['DOGE:mainnet'], 6319000);
        assert.strictEqual(DISPENSER_FRESHNESS_ACTIVATION.testnet, 0);
        assert.strictEqual(DISPENSER_FRESHNESS_ACTIVATION.regtest, 0);
    });
});
