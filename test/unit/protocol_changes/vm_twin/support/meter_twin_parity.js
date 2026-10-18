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
const { codeIdentity } = require('../../../../../bin/consensus-identity.js');
const ProtocolChanges = require('../../../../../src/protocol_changes.js');
const table = require('../../../../../src/protocol_changes/changes_5.js');

const IDENTITY_PIN = path.resolve(__dirname, '../../../../../bin/pins/at1-consensus-identity.json');
const NETWORKS = ['mainnet', 'testnet', 'regtest'];

function describeMeterTwinParity({ name, slug, vmModule, activationExport, predicateExport }) {
    const key = 'protocol_changes.changes.' + name;
    const mainnetKey = 'protocol_changes.' + name + '_MAINNET_TIME';
    const testnetKey = 'protocol_changes.' + name + '_TESTNET_TIME';
    const mirrorKey = 'xchain-vm.' + activationExport;
    const vmTarget = process.env.XCHAIN_VM_DIR
        ? path.join(process.env.XCHAIN_VM_DIR, vmModule)
        : require.resolve('xchain-vm/' + vmModule);
    const vm = require(vmTarget);
    const vmActivation = vm[activationExport];
    const vmActivationAt = vm[predicateExport];
    const asRow = (time) => (time === null ? ProtocolChanges.UNARMED : time);

    function indexerEnabledAt(network, time) {
        const pc = new ProtocolChanges({
            config: { NETWORK: network },
            util: {},
            decoderDb: { getBlockTime: async () => time },
        });
        return pc.isEnabled(name, 1);
    }

    describe('protocol_changes/vm_twin/' + slug + '_matches_vm: activation parity @regression @tier1', function () {
        it('registers the time-table row in part 5, unarmed on mainnet and testnet, live on regtest', function () {
            const row = ProtocolChanges.get(key);
            assert.deepStrictEqual(new ProtocolChanges({ config: {}, util: {} }).changes[name], row);
            assert.deepStrictEqual(table.find((entry) => entry[0] === name), [
                name, '0.2.0', ProtocolChanges.UNARMED, ProtocolChanges.UNARMED, 0, 0, 0, 0,
            ]);
            assert.strictEqual(ProtocolChanges[name + '_MAINNET_TIME'], ProtocolChanges.UNARMED);
            assert.strictEqual(ProtocolChanges[name + '_TESTNET_TIME'], ProtocolChanges.UNARMED);
            assert.strictEqual(ProtocolChanges.get(mainnetKey), ProtocolChanges.UNARMED);
            assert.strictEqual(ProtocolChanges.get(testnetKey), ProtocolChanges.UNARMED);
        });

        it('matches the VM instant on every network', function () {
            assert.deepStrictEqual(Object.keys(vmActivation).sort(), NETWORKS.slice().sort(),
                'the VM map names a network this test does not compare');
            const row = ProtocolChanges.get(key);
            for (const network of NETWORKS) {
                assert.strictEqual(asRow(vmActivation[network]), row[network + '_time'], network + '_time');
            }
        });

        it('agrees with the VM predicate on each side of every armed instant', async function () {
            const row = ProtocolChanges.get(key);
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
                assert.strictEqual(await indexerEnabledAt(network, instant), vmActivationAt(network, instant),
                    network + ' at the instant');
            }
            assert.strictEqual(await indexerEnabledAt('regtest', 0), true);
            assert.strictEqual(vmActivationAt('regtest', 0), true);
            assert.strictEqual(vmActivationAt('unknown', 0), false);
        });

        it('mirrors the VM value in the armed map and pins every row in the consensus identity', function () {
            const identity = codeIdentity('regtest');
            assert.strictEqual(identity.armed_map_fingerprint_unreadable_reason, null);
            const pin = JSON.parse(fs.readFileSync(IDENTITY_PIN, 'utf8'));
            const keys = [key, mainnetKey, testnetKey, mirrorKey];
            for (const identityKey of keys) {
                assert.match(identity.armed_map_rows[identityKey], /^[0-9a-f]{64}$/, identityKey);
                assert.strictEqual(pin.bare_checkout.armed_map_rows[identityKey],
                    identity.armed_map_rows[identityKey], 'bare ' + identityKey);
                assert.strictEqual(pin.armed_regtest_venue.armed_map_rows[identityKey],
                    identity.armed_map_rows[identityKey], 'armed ' + identityKey);
            }
        });
    });
}

module.exports = { describeMeterTwinParity };
