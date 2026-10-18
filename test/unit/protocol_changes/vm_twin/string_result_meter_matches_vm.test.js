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
const fs = require('fs');
const path = require('path');
const { codeIdentity } = require('../../../../bin/consensus-identity.js');
const ProtocolChanges = require('../../../../src/protocol_changes.js');
const table = require('../../../../src/protocol_changes/changes_5.js');

const NAME = 'STRING_RESULT_METER';
const KEY = 'protocol_changes.changes.' + NAME;
const MIRROR_KEY = 'xchain-vm.STRING_RESULT_METER_ACTIVATION';
const IDENTITY_PIN = path.resolve(__dirname, '../../../../bin/pins/at1-consensus-identity.json');
const VM_MODULE = 'src/index/string_result_meter.js';
const NETWORKS = ['mainnet', 'testnet', 'regtest'];
const vmTarget = process.env.XCHAIN_VM_DIR
    ? path.join(process.env.XCHAIN_VM_DIR, VM_MODULE)
    : require.resolve('xchain-vm/' + VM_MODULE);
const {
    STRING_RESULT_METER_ACTIVATION: vmActivation,
    isStringResultMeterActive: vmActivationAt,
} = require(vmTarget);

const asRow = (time) => (time === null ? ProtocolChanges.UNARMED : time);
// The v0.25.0 cut arms testnet at block time 1792416600.
const TESTNET_TIME = 1792416600;

function indexerEnabledAt(network, time) {
    const pc = new ProtocolChanges({ config: { NETWORK: network }, util: {}, decoderDb: { getBlockTime: async () => time } });
    return pc.isEnabled(NAME, 1);
}

describe('protocol_changes/vm_twin/string_result_meter_matches_vm: activation parity @regression @tier1', function () {
    it('registers the part 5 row unarmed on mainnet, armed on testnet at its v0.25.0 instant, and live on regtest', function () {
        const row = ProtocolChanges.get(KEY);
        assert.deepStrictEqual(new ProtocolChanges({ config: {}, util: {} }).changes[NAME], row);
        assert.deepStrictEqual(table.find((entry) => entry[0] === NAME), [
            NAME, '0.2.0', ProtocolChanges.UNARMED, TESTNET_TIME, 0, 0, 0, 0,
        ]);
        assert.strictEqual(ProtocolChanges.STRING_RESULT_METER_MAINNET_TIME, ProtocolChanges.UNARMED);
        assert.strictEqual(ProtocolChanges.STRING_RESULT_METER_TESTNET_TIME, TESTNET_TIME);
        assert.strictEqual(ProtocolChanges.get('protocol_changes.STRING_RESULT_METER_MAINNET_TIME'), ProtocolChanges.UNARMED);
        assert.strictEqual(ProtocolChanges.get('protocol_changes.STRING_RESULT_METER_TESTNET_TIME'), TESTNET_TIME);
    });

    it('matches the VM instant on every network', function () {
        assert.deepStrictEqual(Object.keys(vmActivation).sort(), NETWORKS.slice().sort());
        const row = ProtocolChanges.get(KEY);
        for (const network of NETWORKS) {
            assert.strictEqual(asRow(vmActivation[network]), row[network + '_time'], network + '_time');
        }
    });

    it('agrees with the VM predicate at the mainnet sentinel, the testnet instant and regtest genesis', async function () {
        assert.strictEqual(await indexerEnabledAt('mainnet', ProtocolChanges.UNARMED - 1), false, 'mainnet');
        assert.strictEqual(vmActivationAt('mainnet', ProtocolChanges.UNARMED - 1), false, 'mainnet');
        for (const time of [TESTNET_TIME - 1, TESTNET_TIME]) {
            assert.strictEqual(await indexerEnabledAt('testnet', time), time >= TESTNET_TIME, 'testnet ' + time);
            assert.strictEqual(vmActivationAt('testnet', time), time >= TESTNET_TIME, 'testnet ' + time);
        }
        assert.strictEqual(await indexerEnabledAt('regtest', 0), true);
        assert.strictEqual(vmActivationAt('regtest', 0), true);
        assert.strictEqual(vmActivationAt('unknown', 0), false);
    });

    it('mirrors the VM value in the armed map and pins every row in the consensus identity', function () {
        const identity = codeIdentity('regtest');
        assert.strictEqual(identity.armed_map_fingerprint_unreadable_reason, null);
        const pin = JSON.parse(fs.readFileSync(IDENTITY_PIN, 'utf8'));
        const keys = [KEY, 'protocol_changes.STRING_RESULT_METER_MAINNET_TIME',
            'protocol_changes.STRING_RESULT_METER_TESTNET_TIME', MIRROR_KEY];
        for (const key of keys) {
            assert.match(identity.armed_map_rows[key], /^[0-9a-f]{64}$/, key);
            assert.strictEqual(pin.bare_checkout.armed_map_rows[key], identity.armed_map_rows[key], 'bare ' + key);
            assert.strictEqual(pin.armed_regtest_venue.armed_map_rows[key], identity.armed_map_rows[key], 'armed ' + key);
        }
    });
});
