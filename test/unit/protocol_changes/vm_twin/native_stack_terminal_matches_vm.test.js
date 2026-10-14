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

const KEY = 'native_stack_terminal_heights.NATIVE_STACK_TERMINAL_ACTIVATION';
const IDENTITY_PIN = path.resolve(__dirname, '../../../../bin/pins/at1-consensus-identity.json');
const VM_MODULE = 'src/index/native_stack/activation.js';
const COIN_KEYS = [
    'BTC:mainnet',
    'LTC:mainnet',
    'DOGE:mainnet',
    'BTC:testnet',
    'LTC:testnet',
    'DOGE:testnet',
];
const vmTarget = process.env.XCHAIN_VM_DIR
    ? path.join(process.env.XCHAIN_VM_DIR, VM_MODULE)
    : require.resolve('xchain-vm/' + VM_MODULE);
const {
    NATIVE_STACK_TERMINAL_ACTIVATION: vmActivation,
    isNativeStackTerminalActive: vmActivationAt,
} = require(vmTarget);

function indexerActivation() {
    return ProtocolChanges.copy(KEY);
}

function indexerActivationAt(network, coin, height) {
    return ProtocolChanges.activeAt(KEY, network, coin, height, null);
}

describe('protocol_changes/vm_twin/native_stack_terminal_matches_vm: activation parity @regression @tier1', function () {
    it('registers a per-chain height row, unarmed on mainnet and testnet, live on regtest', function () {
        assert.strictEqual(ProtocolChanges.registry.unitOf(KEY), 'height');
        assert.deepStrictEqual(indexerActivation(), {
            'BTC:mainnet': ProtocolChanges.UNARMED,
            'LTC:mainnet': ProtocolChanges.UNARMED,
            'DOGE:mainnet': ProtocolChanges.UNARMED,
            'BTC:testnet': ProtocolChanges.UNARMED,
            'LTC:testnet': ProtocolChanges.UNARMED,
            'DOGE:testnet': ProtocolChanges.UNARMED,
            testnet: ProtocolChanges.UNARMED,
            regtest: 0,
        });
    });

    it('matches every VM mainnet and testnet activation', function () {
        const indexer = indexerActivation();
        assert.deepStrictEqual(Object.keys(vmActivation).sort(), COIN_KEYS.slice().sort(),
            'native stack terminal: the VM map names a slot this test does not compare');
        for (const coinKey of COIN_KEYS) {
            const [coin, network] = coinKey.split(':');
            const vmHeight = vmActivation[coinKey];
            if (vmHeight === null) {
                assert.strictEqual(indexer[coinKey], ProtocolChanges.UNARMED,
                    coinKey + ' must pair VM null with indexer UNARMED');
                assert.strictEqual(indexerActivationAt(network, coin, ProtocolChanges.UNARMED - 1), false);
                assert.strictEqual(vmActivationAt(network, coin, ProtocolChanges.UNARMED - 1), false);
                continue;
            }
            assert.ok(Number.isFinite(vmHeight), coinKey + ' VM activation must be null or a finite height');
            assert.strictEqual(indexer[coinKey], vmHeight, coinKey + ' activation drifted from the VM');
            assert.strictEqual(indexerActivationAt(network, coin, vmHeight - 1),
                vmActivationAt(network, coin, vmHeight - 1), coinKey + ' below the height');
            assert.strictEqual(indexerActivationAt(network, coin, vmHeight),
                vmActivationAt(network, coin, vmHeight), coinKey + ' at the height');
        }
    });

    it('is live from genesis on regtest and dark on an unknown network, on both sides', function () {
        assert.strictEqual(indexerActivation().regtest, 0);
        assert.strictEqual(indexerActivationAt('regtest', 'LTC', -1), false);
        assert.strictEqual(vmActivationAt('regtest', 'LTC', -1), true);
        assert.strictEqual(indexerActivationAt('regtest', 'LTC', 0), true);
        assert.strictEqual(vmActivationAt('regtest', 'LTC', 0), true);
        assert.strictEqual(indexerActivationAt('unknown', 'LTC', 0), false);
        assert.strictEqual(vmActivationAt('unknown', 'LTC', 0), false);
    });

    it('pins the registry row in the consensus identity', function () {
        const rowHash = codeIdentity('regtest').armed_map_rows[KEY];
        const pin = JSON.parse(fs.readFileSync(IDENTITY_PIN, 'utf8'));
        assert.strictEqual(pin.bare_checkout.armed_map_rows[KEY], rowHash);
        assert.strictEqual(pin.armed_regtest_venue.armed_map_rows[KEY], rowHash);
    });
});
