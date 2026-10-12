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

const KEYS = [
    'attest_relay_fee_activation.ATTEST_RELAY_FEE_ACTIVATION',
];

const COINS = ['BTC', 'LTC', 'DOGE'];
const ROW_KEYS = ['BTC:testnet', 'DOGE:testnet', 'LTC:testnet', 'mainnet', 'regtest', 'testnet'];
const isArmed = (h) => Number.isFinite(h) && h > 1 && h !== ProtocolChanges.UNARMED;

// Active at the armed height, inactive one below it and at height 1.
function assertArmedAt(key, coin, armed) {
    assert.strictEqual(ProtocolChanges.activeAt(key, 'testnet', coin, armed, null), true, coin + ' at the armed height');
    assert.strictEqual(ProtocolChanges.activeAt(key, 'testnet', coin, armed - 1, null), false, coin + ' below the armed height');
    assert.strictEqual(ProtocolChanges.activeAt(key, 'testnet', coin, 1, null), false, coin + ' at height 1');
}

describe('relay fee activation row', function () {
    for (const key of KEYS) {
        it(key + ' is a frozen height row with explicit network defaults', function () {
            assert.strictEqual(ProtocolChanges.registry.unitOf(key), 'height');
            const row = ProtocolChanges.get(key);
            assert.deepStrictEqual(Object.keys(row).sort(), ROW_KEYS);
            assert.strictEqual(row.mainnet, ProtocolChanges.UNARMED);
            assert.strictEqual(row.regtest, 0);
            for (const coin of COINS) assert.ok(isArmed(row[coin + ':testnet']), coin + ':testnet is armed');
            // relay_fee_carve.js reads with a null coin against the BTC staking snapshot
            // block, so the bare testnet key must carry the BTC:testnet arming.
            assert.strictEqual(row.testnet, row['BTC:testnet']);
            assert.strictEqual(Object.isFrozen(row), true);
        });

        it(key + ' is inactive on mainnet, active on testnet from the armed height, and active from regtest genesis', function () {
            const row = ProtocolChanges.get(key);
            assert.strictEqual(ProtocolChanges.activeAt(key, 'mainnet', 'BTC', ProtocolChanges.UNARMED - 1, null), false);
            assertArmedAt(key, null, row.testnet);
            for (const coin of COINS) assertArmedAt(key, coin, row[coin + ':testnet']);
            assert.strictEqual(ProtocolChanges.activeAt(key, 'regtest', 'BTC', 0, null), true);
            assert.strictEqual(ProtocolChanges.activeAt(key, 'regtest', 'BTC', -1, null), false);
        });
    }
});
