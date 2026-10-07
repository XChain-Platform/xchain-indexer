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
    'dispenser_delay_protocol_time_activation.DISPENSER_DELAY_PROTOCOL_TIME_ACTIVATION',
    'bridge_policy_refusal_record_activation.BRIDGE_POLICY_REFUSAL_RECORD_ACTIVATION',
    'price_wire_trailing_activation.PRICE_WIRE_TRAILING_ACTIVATION',
];

const EXPECTED = {
    mainnet: ProtocolChanges.UNARMED,
    'BTC:testnet': ProtocolChanges.UNARMED,
    'LTC:testnet': ProtocolChanges.UNARMED,
    'DOGE:testnet': ProtocolChanges.UNARMED,
    testnet: ProtocolChanges.UNARMED,
    regtest: 0,
};

describe('three unarmed flag days registered on 2026-10-07', function () {
    for (const key of KEYS) {
        it(key + ' is a frozen height row with explicit network defaults', function () {
            assert.strictEqual(ProtocolChanges.registry.unitOf(key), 'height');
            const row = ProtocolChanges.get(key);
            assert.deepStrictEqual(row, EXPECTED);
            assert.strictEqual(Object.isFrozen(row), true);
        });

        it(key + ' is inactive on launched networks and active from regtest genesis', function () {
            assert.strictEqual(ProtocolChanges.activeAt(key, 'mainnet', 'BTC', ProtocolChanges.UNARMED - 1, null), false);
            for (const coin of ['BTC', 'LTC', 'DOGE']) {
                assert.strictEqual(ProtocolChanges.activeAt(key, 'testnet', coin, ProtocolChanges.UNARMED - 1, null), false, coin);
            }
            assert.strictEqual(ProtocolChanges.activeAt(key, 'regtest', 'BTC', 0, null), true);
            assert.strictEqual(ProtocolChanges.activeAt(key, 'regtest', 'BTC', -1, null), false);
        });
    }
});
