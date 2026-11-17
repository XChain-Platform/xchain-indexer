'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

const assert = require('assert');
const ProtocolChanges = require('../../../src/protocol_changes.js');
const table = require('../../../src/protocol_changes/changes_5.js');

const KEY = 'protocol_changes.changes.ORDER_GET_ADDRESS_COIN';

// The ORDER GET_ADDRESS coin check, armed on testnet at 2026-11-17T00:00Z. Judged through
// isEnabled() over a stubbed decoder block time: dark at time 1 and one second short, live
// from the instant. Mainnet stays dark and regtest is live from genesis.
function enabledAt(network, time) {
    const pc = new ProtocolChanges({ config: { NETWORK: network }, util: {}, decoderDb: { getBlockTime: async () => time } });
    return pc.isEnabled('ORDER_GET_ADDRESS_COIN', 1);
}

describe('protocol_changes/ORDER_GET_ADDRESS_COIN row @regression @tier1', function () {
    it('is the final part 5 row and has the registry shape', function () {
        const changes = new ProtocolChanges({ config: {}, util: {} }).changes;
        assert.deepStrictEqual(table[table.length - 1], [
            'ORDER_GET_ADDRESS_COIN', '0.2.0', ProtocolChanges.UNARMED, 1794873600, 0, 0, 0, 0,
        ]);
        assert.ok(Object.prototype.hasOwnProperty.call(changes, 'ORDER_GET_ADDRESS_COIN'));
        assert.deepStrictEqual(changes.ORDER_GET_ADDRESS_COIN, ProtocolChanges.get(KEY));
    });

    it('is unarmed on mainnet, armed on testnet at its instant and active from regtest genesis', async function () {
        const row = ProtocolChanges.get(KEY);
        assert.strictEqual(row.mainnet_time, ProtocolChanges.UNARMED);
        assert.strictEqual(row.testnet_time, 1794873600);
        assert.strictEqual(row.regtest_time, 0);
        assert.strictEqual(await enabledAt('testnet', 1), false);
        assert.strictEqual(await enabledAt('testnet', row.testnet_time - 1), false);
        assert.strictEqual(await enabledAt('testnet', row.testnet_time), true);
        assert.strictEqual(await enabledAt('mainnet', ProtocolChanges.UNARMED - 1), false);
        assert.strictEqual(await enabledAt('regtest', 0), true);
    });

    it('publishes both instants as gate constants from the entry', function () {
        const row = ProtocolChanges.get(KEY);
        assert.strictEqual(ProtocolChanges.ORDER_GET_ADDRESS_COIN_MAINNET_TIME, ProtocolChanges.UNARMED);
        assert.strictEqual(ProtocolChanges.ORDER_GET_ADDRESS_COIN_TESTNET_TIME, row.testnet_time);
        assert.strictEqual(ProtocolChanges.get('protocol_changes.ORDER_GET_ADDRESS_COIN_MAINNET_TIME'), ProtocolChanges.UNARMED);
        assert.strictEqual(ProtocolChanges.get('protocol_changes.ORDER_GET_ADDRESS_COIN_TESTNET_TIME'), row.testnet_time);
    });
});
