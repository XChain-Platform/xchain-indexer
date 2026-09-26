/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const gateRegistry = require('../../../src/consensus/gate_registry');

const KEY = 'empty_allow_list_denies_activation.EMPTY_ALLOW_LIST_DENIES';

describe('empty allow list denial activation @regression @tier1', function () {
    it('parks public networks at the sentinel and activates regtest at genesis', function () {
        assert.deepStrictEqual(gateRegistry.get(KEY), {
            mainnet: 9999999999,
            'BTC:testnet': 9999999999,
            'LTC:testnet': 9999999999,
            'DOGE:testnet': 9999999999,
            testnet: 9999999999,
            regtest: 0,
        });
        assert.strictEqual(gateRegistry.activeAt(KEY, 'mainnet', 'BTC', 9999999998, null), false);
        for (const coin of ['BTC', 'LTC', 'DOGE']) {
            assert.strictEqual(gateRegistry.activeAt(KEY, 'testnet', coin, 9999999998, null), false);
        }
        assert.strictEqual(gateRegistry.activeAt(KEY, 'regtest', 'BTC', 0, null), true);
    });
});
