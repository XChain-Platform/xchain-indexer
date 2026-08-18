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
 * both sides of the gate, and mainnet is pinned to the UNARMED sentinel: the
 * dispenser-family cohort anchor (1786060800) is already past, and a tightening
 * on a retroactive boundary forks a from-genesis replay. Arming is an operator
 * act, so a change of this value is expected to fail here and be re-pinned
 * deliberately.
 */

'use strict';

const assert = require('assert');
const { isDispenserGiveAmountActive, DISPENSER_GIVE_AMOUNT_ACTIVATION } =
    require('../../src/dispenser_give_amount_activation.js');

describe('dispenser GIVE_AMOUNT activation predicate @regression @tier1', function () {

    it('mainnet is UNARMED on the house sentinel, never the passed cohort anchor', function () {
        assert.strictEqual(DISPENSER_GIVE_AMOUNT_ACTIVATION.mainnet, 9999999999);
        assert.notStrictEqual(DISPENSER_GIVE_AMOUNT_ACTIVATION.mainnet, 1786060800);
        assert.strictEqual(isDispenserGiveAmountActive(1786060800, 'mainnet'), false);
        assert.strictEqual(isDispenserGiveAmountActive(9999999998, 'mainnet'), false);
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
