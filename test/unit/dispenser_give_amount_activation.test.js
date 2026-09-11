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
 * test/unit/dispenser_give_amount_activation.test.js
 *
 * Balance-dispenser GIVE_AMOUNT positivity flag-day. The predicate is pinned
 * both sides of the gate, and mainnet is pinned ARMED AT GENESIS by the
 * 2026-09-09 operator ruling: mainnet carries 0 dispensers and 0 dispenses
 * (measured 2026-09-09), so the rule is identity over the indexed history and a
 * genesis height forks no from-genesis replay. Moving this value is an operator
 * act, so a change is expected to fail here and be re-pinned deliberately.
 */

'use strict';

const assert = require('assert');
const { isDispenserGiveAmountActive, DISPENSER_GIVE_AMOUNT_ACTIVATION } =
    require('../../src/dispenser_give_amount_activation.js');

describe('dispenser GIVE_AMOUNT activation predicate @regression @tier1', function () {

    it('mainnet is ARMED AT GENESIS by the 2026-09-09 ruling, never a sentinel', function () {
        assert.strictEqual(DISPENSER_GIVE_AMOUNT_ACTIVATION.mainnet, 0);
        // The GoLiveGate readback reads either sentinel as "still unarmed", so a
        // regression back to one is a launch blocker, not a cosmetic diff.
        assert.notStrictEqual(DISPENSER_GIVE_AMOUNT_ACTIVATION.mainnet, 9999999999);
        assert.notStrictEqual(DISPENSER_GIVE_AMOUNT_ACTIVATION.mainnet, 999999999);
        // Active at the genesis instant and at every mainnet block time above it,
        // including the passed dispenser-family cohort anchor.
        assert.strictEqual(isDispenserGiveAmountActive(0, 'mainnet'), true);
        assert.strictEqual(isDispenserGiveAmountActive(1, 'mainnet'), true);
        assert.strictEqual(isDispenserGiveAmountActive(1786060800, 'mainnet'), true);
        assert.strictEqual(isDispenserGiveAmountActive(9999999999, 'mainnet'), true);
    });

    it('testnet and regtest are genesis-active (pre-launch cohort)', function () {
        assert.strictEqual(DISPENSER_GIVE_AMOUNT_ACTIVATION.testnet, 0);
        assert.strictEqual(DISPENSER_GIVE_AMOUNT_ACTIVATION.regtest, 0);
        assert.strictEqual(isDispenserGiveAmountActive(0, 'testnet'), true);
        assert.strictEqual(isDispenserGiveAmountActive(1, 'regtest'), true);
    });

    it('unknown network or unparseable time is off (safe: keeps legacy acceptance)', function () {
        assert.strictEqual(isDispenserGiveAmountActive(9999999999, 'stagenet'), false);
        assert.strictEqual(isDispenserGiveAmountActive('nonsense', 'regtest'), false);
        assert.strictEqual(isDispenserGiveAmountActive(undefined, 'mainnet'), false);
    });
});
