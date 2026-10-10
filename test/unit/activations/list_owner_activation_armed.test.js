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

const KEY = 'list_owner_activation.LIST_OWNER_ACTIVATION';

describe('LIST owner activation @regression @tier1', function () {
    it('arms mainnet and regtest at genesis while preserving the per-chain testnet heights', function () {
        assert.deepStrictEqual(gateRegistry.get(KEY), {
            mainnet: 0,
            'BTC:testnet': 155001,
            'LTC:testnet': 4906040,
            'DOGE:testnet': 67962387,
            testnet: 9999999999,
            regtest: 0,
        });
        for (const coin of ['BTC', 'LTC', 'DOGE']) {
            assert.strictEqual(gateRegistry.activeAt(KEY, 'mainnet', coin, 0, null), true);
        }
        assert.strictEqual(gateRegistry.activeAt(KEY, 'testnet', 'BTC', 155000, null), false);
        assert.strictEqual(gateRegistry.activeAt(KEY, 'testnet', 'BTC', 155001, null), true);
        assert.strictEqual(gateRegistry.activeAt(KEY, 'testnet', null, 9999999998, null), false);
        assert.strictEqual(gateRegistry.activeAt(KEY, 'regtest', 'BTC', 0, null), true);
    });
});
