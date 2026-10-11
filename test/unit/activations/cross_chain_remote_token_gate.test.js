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
const ProtocolChanges = require('../../../src/protocol_changes.js');
const { REGTEST_ARMING } = require('../../../src/protocol_changes/shared_rows.js');

const KEY = 'cross_chain_remote_token_activation.CROSS_CHAIN_REMOTE_TOKEN_ACTIVATION';
const COINS = ['BTC', 'LTC', 'DOGE'];
const ROW_KEYS = ['BTC:testnet', 'DOGE:testnet', 'LTC:testnet', 'mainnet', 'regtest', 'testnet'];
const isArmed = (h) => Number.isFinite(h) && h > 1 && h !== ProtocolChanges.UNARMED;

describe('CROSS_CHAIN_REMOTE_TOKEN_ACTIVATION', function () {
    it('is a frozen height row with explicit defaults for every launched key', function () {
        assert.strictEqual(ProtocolChanges.registry.unitOf(KEY), 'height');
        const row = ProtocolChanges.get(KEY);
        assert.deepStrictEqual(Object.keys(row).sort(), ROW_KEYS);
        assert.strictEqual(row.mainnet, ProtocolChanges.UNARMED);
        assert.strictEqual(row.testnet, ProtocolChanges.UNARMED);
        assert.strictEqual(row.regtest, 0);
        for (const coin of COINS) assert.ok(isArmed(row[coin + ':testnet']), coin + ':testnet is armed');
        assert.strictEqual(Object.isFrozen(row), true);
    });

    it('stays unarmed on mainnet and is active on each testnet chain from its armed height', function () {
        assert.strictEqual(ProtocolChanges.activeAt(KEY, 'mainnet', 'BTC', ProtocolChanges.UNARMED - 1, null), false);
        const row = ProtocolChanges.get(KEY);
        for (const coin of COINS) {
            const armed = row[coin + ':testnet'];
            assert.strictEqual(ProtocolChanges.activeAt(KEY, 'testnet', coin, armed, null), true, coin + ' at the armed height');
            assert.strictEqual(ProtocolChanges.activeAt(KEY, 'testnet', coin, armed - 1, null), false, coin + ' below the armed height');
            assert.strictEqual(ProtocolChanges.activeAt(KEY, 'testnet', coin, 1, null), false, coin + ' at height 1');
        }
    });

    it('is active from regtest genesis without an environment arming lever', function () {
        assert.strictEqual(REGTEST_ARMING[KEY], undefined);
        assert.strictEqual(ProtocolChanges.activeAt(KEY, 'regtest', 'BTC', -1, null), false);
        assert.strictEqual(ProtocolChanges.activeAt(KEY, 'regtest', 'BTC', 0, null), true);
    });
});
