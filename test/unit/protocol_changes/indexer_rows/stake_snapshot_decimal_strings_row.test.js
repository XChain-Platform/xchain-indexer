'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

const assert = require('assert');
const ProtocolChanges = require('../../../../src/protocol_changes.js');

const KEY = 'protocol_changes.changes.STAKE_SNAPSHOT_DECIMAL_STRINGS';

// The v0.23.0 cut armed this row on testnet with one dated instant. The instant is read from
// the registry row, never repeated here, and judged through isEnabled() over a stubbed decoder
// block time: dark at time 1 and one second short, live from the instant. Mainnet stays dark.
function enabledAt(name, network, time) {
    const pc = new ProtocolChanges({ config: { NETWORK: network }, util: {}, decoderDb: { getBlockTime: async () => time } });
    return pc.isEnabled(name, 1);
}

async function assertArmedOnTestnetOnly(name, row) {
    assert.strictEqual(row.mainnet_time, ProtocolChanges.UNARMED);
    assert.ok(Number.isInteger(row.testnet_time) && row.testnet_time > 1 && row.testnet_time < ProtocolChanges.UNARMED,
        name + ' testnet_time is not a sized instant: ' + row.testnet_time);
    assert.strictEqual(row.regtest_time, 0);
    assert.strictEqual(await enabledAt(name, 'testnet', 1), false);
    assert.strictEqual(await enabledAt(name, 'testnet', row.testnet_time - 1), false);
    assert.strictEqual(await enabledAt(name, 'testnet', row.testnet_time), true);
    assert.strictEqual(await enabledAt(name, 'mainnet', ProtocolChanges.UNARMED - 1), false);
    assert.strictEqual(await enabledAt(name, 'regtest', 0), true);
}

describe('protocol_changes/STAKE_SNAPSHOT_DECIMAL_STRINGS row @regression @tier1', function () {
    it('is unarmed on production networks and active from regtest genesis', async function () {
        const row = ProtocolChanges.get(KEY);
        await assertArmedOnTestnetOnly('STAKE_SNAPSHOT_DECIMAL_STRINGS', row);
        assert.strictEqual(ProtocolChanges.STAKE_SNAPSHOT_DECIMAL_STRINGS_MAINNET_TIME, ProtocolChanges.UNARMED);
        assert.strictEqual(ProtocolChanges.STAKE_SNAPSHOT_DECIMAL_STRINGS_TESTNET_TIME, row.testnet_time);
    });

    it('registers the 0.2.0 row and both network constants', function () {
        const table = new ProtocolChanges({ config: {}, util: {} }).changes;
        assert.ok(Object.prototype.hasOwnProperty.call(table, 'STAKE_SNAPSHOT_DECIMAL_STRINGS'));
        assert.deepStrictEqual(table.STAKE_SNAPSHOT_DECIMAL_STRINGS, ProtocolChanges.get(KEY));
        assert.deepStrictEqual([
            table.STAKE_SNAPSHOT_DECIMAL_STRINGS.version_major,
            table.STAKE_SNAPSHOT_DECIMAL_STRINGS.version_minor,
            table.STAKE_SNAPSHOT_DECIMAL_STRINGS.version_revision,
        ], [0, 2, 0]);
        assert.strictEqual(ProtocolChanges.get('protocol_changes.STAKE_SNAPSHOT_DECIMAL_STRINGS_MAINNET_TIME'), ProtocolChanges.UNARMED);
        assert.strictEqual(ProtocolChanges.get('protocol_changes.STAKE_SNAPSHOT_DECIMAL_STRINGS_TESTNET_TIME'), ProtocolChanges.get(KEY).testnet_time);
    });
});
