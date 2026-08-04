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
 * test/unit/dispenser_caps_activation.test.js
 *
 * DISPENSER lifetime caps flag-day ( / Package 14). MAX_DISPENSES and
 * MAX_REFILLS enforcement is gated WITH the dispenser-family cohort: block-TIME,
 * mainnet 1786060800, testnet/regtest genesis (byte-for-byte the shape of
 * dispense_cancelling_match / dispenser_ownership_cancel). These tests pin the
 * predicate both sides of the gate.
 */

'use strict';

const assert = require('assert');
const { isDispenserCapsActive, DISPENSER_CAPS_ACTIVATION } =
    require('../../src/dispenser_caps_activation.js');

describe('dispenser caps activation predicate  @regression @tier1', function () {

    it('mainnet flips at the coordinated 2.0.0 flag-day (1786060800)', function () {
        assert.strictEqual(isDispenserCapsActive(1786060799, 'mainnet'), false);
        assert.strictEqual(isDispenserCapsActive(1786060800, 'mainnet'), true);
        assert.strictEqual(isDispenserCapsActive(1786060801, 'mainnet'), true);
    });

    it('testnet and regtest are genesis-active (pre-launch cohort)', function () {
        assert.strictEqual(isDispenserCapsActive(0, 'testnet'), true);
        assert.strictEqual(isDispenserCapsActive(0, 'regtest'), true);
        assert.strictEqual(isDispenserCapsActive(1, 'testnet'), true);
    });

    it('unknown network or unparseable time is off (safe: keeps legacy uncapped behavior)', function () {
        assert.strictEqual(isDispenserCapsActive(9999999999, 'stagenet'), false);
        assert.strictEqual(isDispenserCapsActive('nonsense', 'regtest'), false);
        assert.strictEqual(isDispenserCapsActive(undefined, 'mainnet'), false);
    });

    it('shares the dispenser-family cohort timestamp', function () {
        assert.strictEqual(DISPENSER_CAPS_ACTIVATION.mainnet, 1786060800);
        assert.strictEqual(DISPENSER_CAPS_ACTIVATION.testnet, 0);
        assert.strictEqual(DISPENSER_CAPS_ACTIVATION.regtest, 0);
    });
});
