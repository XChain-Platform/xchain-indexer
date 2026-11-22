'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert');
const ProtocolChanges = require('../../../../src/protocol_changes.js');
const table = require('../../../../src/protocol_changes/changes_5.js');

const KEY = 'protocol_changes.changes.LINT_REGEX_GROUP_DEPTH';

function enabledAt(name, network, time) {
    const pc = new ProtocolChanges({
        config: { NETWORK: network },
        util: {},
        decoderDb: { getBlockTime: async () => time }
    });
    return pc.isEnabled(name, 1);
}

describe('protocol_changes/LINT_REGEX_GROUP_DEPTH row @regression @tier1', function () {
    it('is registered in part 5 and has the registry shape', function () {
        const changes = new ProtocolChanges({ config: {}, util: {} }).changes;
        const entry = table.find((row) => row[0] === 'LINT_REGEX_GROUP_DEPTH');
        assert.ok(Object.prototype.hasOwnProperty.call(changes, 'LINT_REGEX_GROUP_DEPTH'));
        assert.deepStrictEqual(changes.LINT_REGEX_GROUP_DEPTH, ProtocolChanges.get(KEY));
        assert.deepStrictEqual(entry, [
            'LINT_REGEX_GROUP_DEPTH', '0.2.0', ProtocolChanges.UNARMED,
            1794873600, 0, 0, 0, 0
        ]);
    });

    it('is unarmed on mainnet, armed on testnet at its instant and active on regtest', async function () {
        const row = ProtocolChanges.get(KEY);
        assert.strictEqual(row.mainnet_time, ProtocolChanges.UNARMED);
        assert.strictEqual(row.testnet_time, 1794873600);
        assert.strictEqual(row.regtest_time, 0);
        assert.strictEqual(await enabledAt('LINT_REGEX_GROUP_DEPTH', 'testnet', 1794873599), false);
        assert.strictEqual(await enabledAt('LINT_REGEX_GROUP_DEPTH', 'testnet', 1794873600), true);
        assert.strictEqual(await enabledAt('LINT_REGEX_GROUP_DEPTH', 'mainnet', 9999999998), false);
        assert.strictEqual(await enabledAt('LINT_REGEX_GROUP_DEPTH', 'regtest', 0), true);
        assert.strictEqual(ProtocolChanges.LINT_REGEX_GROUP_DEPTH_MAINNET_TIME, ProtocolChanges.UNARMED);
        assert.strictEqual(ProtocolChanges.LINT_REGEX_GROUP_DEPTH_TESTNET_TIME, row.testnet_time);
    });

    it('matches the bundled VM activation map per network', function () {
        const vm = require('xchain-vm');
        const gate = vm.LINT_REGEX_GROUP_DEPTH_ACTIVATION;
        assert.notStrictEqual(gate, undefined,
            'xchain-vm did not export LINT_REGEX_GROUP_DEPTH_ACTIVATION');
        const row = ProtocolChanges.get(KEY);
        const asRow = (time) => (time === null ? ProtocolChanges.UNARMED : time);
        assert.strictEqual(asRow(gate.mainnet), row.mainnet_time, 'VM mainnet activation');
        assert.strictEqual(asRow(gate.testnet), row.testnet_time, 'VM testnet activation');
        assert.strictEqual(asRow(gate.regtest), row.regtest_time, 'VM regtest activation');
    });
});
