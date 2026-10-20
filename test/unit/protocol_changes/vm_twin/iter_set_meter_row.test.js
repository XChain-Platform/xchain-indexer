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
const table = require('../../../../src/protocol_changes/changes_5.js');

const KEY = 'protocol_changes.changes.ITER_SET_METER';

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

describe('protocol_changes/ITER_SET_METER row @regression @tier1', function () {
    it('is registered in part 5 and has the registry shape', function () {
        const changes = new ProtocolChanges({ config: {}, util: {} }).changes;
        const entry = table.find((row) => row[0] === 'ITER_SET_METER');
        assert.ok(Object.prototype.hasOwnProperty.call(changes, 'ITER_SET_METER'));
        assert.deepStrictEqual(changes.ITER_SET_METER, ProtocolChanges.get(KEY));
        assert.deepStrictEqual(entry, [
            'ITER_SET_METER', '0.2.0', ProtocolChanges.UNARMED,
            ProtocolChanges.get(KEY).testnet_time, 0, 0, 0, 0,
        ]);
    });

    it('is unarmed on mainnet, armed on testnet at its instant and active from regtest genesis', async function () {
        const row = ProtocolChanges.get(KEY);
        await assertArmedOnTestnetOnly('ITER_SET_METER', row);
        assert.strictEqual(ProtocolChanges.ITER_SET_METER_MAINNET_TIME, ProtocolChanges.UNARMED);
        assert.strictEqual(ProtocolChanges.ITER_SET_METER_TESTNET_TIME, row.testnet_time);
        assert.strictEqual(ProtocolChanges.get('protocol_changes.ITER_SET_METER_MAINNET_TIME'), ProtocolChanges.UNARMED);
        assert.strictEqual(ProtocolChanges.get('protocol_changes.ITER_SET_METER_TESTNET_TIME'), row.testnet_time);

        const vm = require('xchain-vm');
        const gate = vm.ITER_SET_METER_ACTIVATION;
        assert.notStrictEqual(gate, undefined,
            'xchain-vm did not export ITER_SET_METER_ACTIVATION');
        const asRow = (time) => (time === null ? ProtocolChanges.UNARMED : time);
        assert.strictEqual(asRow(gate.mainnet), row.mainnet_time, 'VM mainnet activation');
        assert.strictEqual(asRow(gate.testnet), row.testnet_time, 'VM testnet activation');
        assert.strictEqual(asRow(gate.regtest), row.regtest_time, 'VM regtest activation');
    });
});
