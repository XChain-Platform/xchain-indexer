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
    'cross_chain_remote_token_activation.CROSS_CHAIN_REMOTE_TOKEN_ACTIVATION',
    'dispenser_delay_protocol_time_activation.DISPENSER_DELAY_PROTOCOL_TIME_ACTIVATION',
    'bridge_policy_refusal_record_activation.BRIDGE_POLICY_REFUSAL_RECORD_ACTIVATION',
    'price_wire_trailing_activation.PRICE_WIRE_TRAILING_ACTIVATION',
];

const COINS = ['BTC', 'LTC', 'DOGE'];
const ROW_KEYS = ['BTC:testnet', 'DOGE:testnet', 'LTC:testnet', 'mainnet', 'regtest', 'testnet'];
const isArmed = (h) => Number.isFinite(h) && h > 1 && h !== ProtocolChanges.UNARMED;

describe('four flag days registered on 2026-10-07, armed per testnet coin by the release cut', function () {
    for (const key of KEYS) {
        it(key + ' is a frozen height row with explicit network defaults', function () {
            assert.strictEqual(ProtocolChanges.registry.unitOf(key), 'height');
            const row = ProtocolChanges.get(key);
            assert.deepStrictEqual(Object.keys(row).sort(), ROW_KEYS);
            assert.strictEqual(row.mainnet, ProtocolChanges.UNARMED);
            assert.strictEqual(row.testnet, ProtocolChanges.UNARMED);
            assert.strictEqual(row.regtest, 0);
            for (const coin of COINS) assert.ok(isArmed(row[coin + ':testnet']), coin + ':testnet is armed');
            assert.strictEqual(Object.isFrozen(row), true);
        });

        it(key + ' is inactive on mainnet, active on testnet from the armed height, and active from regtest genesis', function () {
            assert.strictEqual(ProtocolChanges.activeAt(key, 'mainnet', 'BTC', ProtocolChanges.UNARMED - 1, null), false);
            const row = ProtocolChanges.get(key);
            for (const coin of COINS) {
                const armed = row[coin + ':testnet'];
                assert.strictEqual(ProtocolChanges.activeAt(key, 'testnet', coin, armed, null), true, coin + ' at the armed height');
                assert.strictEqual(ProtocolChanges.activeAt(key, 'testnet', coin, armed - 1, null), false, coin + ' below the armed height');
                assert.strictEqual(ProtocolChanges.activeAt(key, 'testnet', coin, 1, null), false, coin + ' at height 1');
            }
            assert.strictEqual(ProtocolChanges.activeAt(key, 'regtest', 'BTC', 0, null), true);
            assert.strictEqual(ProtocolChanges.activeAt(key, 'regtest', 'BTC', -1, null), false);
        });
    }
});
