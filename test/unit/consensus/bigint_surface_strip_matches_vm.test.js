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
const path = require('path');
const { siblingCheckout, skipOrFail } = require('../../helpers/sibling_checkout.js');
const ProtocolChanges = require('../../../src/protocol_changes.js');

const KEY = 'bigint_surface_strip_heights.BIGINT_SURFACE_STRIP_ACTIVATION';
const VM_MODULE = 'src/index/bigint_surface_strip_heights.js';
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
    : path.join('..', '..', '..', '..', 'xchain-vm', VM_MODULE);
const verdict = siblingCheckout(__dirname, vmTarget);

function indexerActivation() {
    return ProtocolChanges.copy(KEY);
}

describe('consensus/bigint_surface_strip_matches_vm: activation parity @regression @tier1', function () {
    it('matches every VM mainnet and testnet activation', function () {
        if (!verdict.usable)
            return skipOrFail(this, verdict, 'the BigInt surface-strip activation map');

        const vmActivation = require(verdict.path).BIGINT_SURFACE_STRIP_ACTIVATION;
        const indexer = indexerActivation();
        for (const coinKey of COIN_KEYS) {
            const vmHeight = vmActivation[coinKey];
            if (vmHeight === null) {
                assert.strictEqual(indexer[coinKey], ProtocolChanges.UNARMED,
                    coinKey + ' must pair VM null with indexer UNARMED');
                continue;
            }
            assert.ok(Number.isFinite(vmHeight), coinKey + ' VM activation must be null or a finite height');
            assert.strictEqual(indexer[coinKey], vmHeight, coinKey + ' activation drifted from the VM');
        }
    });

    it('passes the same network, coin and height inputs to both activation predicates', function () {
        if (!verdict.usable)
            return skipOrFail(this, verdict, 'the BigInt surface-strip predicate parity witness');

        const vmGate = require(verdict.path);
        for (const [network, coin, height] of [
            ['mainnet', 'BTC', 0],
            ['testnet', 'LTC', ProtocolChanges.UNARMED - 1],
            ['regtest', 'DOGE', 0],
        ]) {
            assert.strictEqual(
                ProtocolChanges.activeAt(KEY, network, coin, height, null),
                vmGate.isBigIntSurfaceStripActive(network, coin, height),
                coin + ':' + network + '@' + height,
            );
        }
    });

    it('keeps the indexer regtest activation at genesis', function () {
        assert.strictEqual(indexerActivation().regtest, 0);
    });
});
