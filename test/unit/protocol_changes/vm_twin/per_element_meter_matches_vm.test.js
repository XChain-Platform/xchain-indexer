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

// The VM resolves PER_ELEMENT_METER_ACTIVATION by block time per network; the indexer
// carries the same instants as its PER_ELEMENT_METER time-table row and two flag-time
// constants, and pins the VM's own value as an xchain-vm armed-map mirror row.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { codeIdentity } = require('../../../../bin/consensus-identity.js');
const ProtocolChanges = require('../../../../src/protocol_changes.js');
const table = require('../../../../src/protocol_changes/changes_5.js');

const NAME = 'PER_ELEMENT_METER';
const KEY = 'protocol_changes.changes.' + NAME;
const MIRROR_KEY = 'xchain-vm.PER_ELEMENT_METER_ACTIVATION';
const IDENTITY_PIN = path.resolve(__dirname, '../../../../bin/pins/at1-consensus-identity.json');
const VM_MODULE = 'src/index/per_element_meter.js';
const NETWORKS = ['mainnet', 'testnet', 'regtest'];
const vmTarget = process.env.XCHAIN_VM_DIR
    ? path.join(process.env.XCHAIN_VM_DIR, VM_MODULE)
    : require.resolve('xchain-vm/' + VM_MODULE);
const {
    PER_ELEMENT_METER_ACTIVATION: vmActivation,
    isPerElementMeterActive: vmActivationAt,
} = require(vmTarget);

// The VM spells an unarmed network null; the indexer spells it UNARMED.
const asRow = (time) => (time === null ? ProtocolChanges.UNARMED : time);

function indexerEnabledAt(network, time) {
    const pc = new ProtocolChanges({ config: { NETWORK: network }, util: {}, decoderDb: { getBlockTime: async () => time } });
    return pc.isEnabled(NAME, 1);
}

describe('protocol_changes/vm_twin/per_element_meter_matches_vm: activation parity @regression @tier1', function () {
    it('registers the time-table row in part 5, unarmed on mainnet, armed on testnet at its v0.24.0 heights, live on regtest', function () {
        const row = ProtocolChanges.get(KEY);
        assert.deepStrictEqual(new ProtocolChanges({ config: {}, util: {} }).changes[NAME], row);
        assert.deepStrictEqual(table.find((entry) => entry[0] === NAME), [
            NAME, '0.2.0', ProtocolChanges.UNARMED, 1792303200, 0, 0, 0, 0,
        ]);
        assert.strictEqual(ProtocolChanges.PER_ELEMENT_METER_MAINNET_TIME, ProtocolChanges.UNARMED);
        // The v0.24.0 cut arms testnet at its shared change instant; mainnet stays unarmed.
        assert.strictEqual(ProtocolChanges.PER_ELEMENT_METER_TESTNET_TIME, 1792303200);
        assert.strictEqual(ProtocolChanges.get('protocol_changes.PER_ELEMENT_METER_MAINNET_TIME'), ProtocolChanges.UNARMED);
        assert.strictEqual(ProtocolChanges.get('protocol_changes.PER_ELEMENT_METER_TESTNET_TIME'), 1792303200);
    });

    it('matches the VM instant on every network', function () {
        assert.deepStrictEqual(Object.keys(vmActivation).sort(), NETWORKS.slice().sort(),
            'the VM map names a network this test does not compare');
        const row = ProtocolChanges.get(KEY);
        for (const network of NETWORKS) {
            assert.strictEqual(asRow(vmActivation[network]), row[network + '_time'], network + '_time');
        }
    });

    it('agrees with the VM predicate on each side of every armed instant', async function () {
        const row = ProtocolChanges.get(KEY);
        for (const network of NETWORKS) {
            const instant = row[network + '_time'];
            if (instant === ProtocolChanges.UNARMED) {
                assert.strictEqual(await indexerEnabledAt(network, ProtocolChanges.UNARMED - 1), false, network);
                assert.strictEqual(vmActivationAt(network, ProtocolChanges.UNARMED - 1), false, network);
                continue;
            }
            if (instant > 0) {
                assert.strictEqual(await indexerEnabledAt(network, instant - 1),
                    vmActivationAt(network, instant - 1), network + ' one second short');
            }
            assert.strictEqual(await indexerEnabledAt(network, instant), vmActivationAt(network, instant), network + ' at the instant');
        }
        assert.strictEqual(await indexerEnabledAt('regtest', 0), true);
        assert.strictEqual(vmActivationAt('regtest', 0), true);
        assert.strictEqual(vmActivationAt('unknown', 0), false);
    });

    it('mirrors the VM value in the armed map and pins every row in the consensus identity', function () {
        const identity = codeIdentity('regtest');
        assert.strictEqual(identity.armed_map_fingerprint_unreadable_reason, null);
        const pin = JSON.parse(fs.readFileSync(IDENTITY_PIN, 'utf8'));
        const keys = [KEY, 'protocol_changes.PER_ELEMENT_METER_MAINNET_TIME', 'protocol_changes.PER_ELEMENT_METER_TESTNET_TIME', MIRROR_KEY];
        for (const key of keys) {
            assert.match(identity.armed_map_rows[key], /^[0-9a-f]{64}$/, key);
            assert.strictEqual(pin.bare_checkout.armed_map_rows[key], identity.armed_map_rows[key], 'bare ' + key);
            assert.strictEqual(pin.armed_regtest_venue.armed_map_rows[key], identity.armed_map_rows[key], 'armed ' + key);
        }
    });
});
