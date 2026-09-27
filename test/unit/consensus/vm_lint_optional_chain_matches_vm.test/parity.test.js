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
const { siblingCheckout, skipOrFail } = require('../../../helpers/sibling_checkout.js');
const { UNARMED } = require('../../../../src/protocol_changes/shared_rows.js');

const VM_MODULE = 'src/index/lint_optional_chain_heights.js';
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
    : path.join('..', '..', '..', '..', '..', 'xchain-vm', VM_MODULE);
const verdict = siblingCheckout(__dirname, vmTarget);

function indexerActivation() {
    return require('../../../../src/consensus/gate_registry')
        .copy('vm_lint_optional_chain_heights.VM_LINT_OPTIONAL_CHAIN_ACTIVATION');
}

describe('consensus/vm_lint_optional_chain_matches_vm: optional-chain activation parity @regression @tier1', function () {
    it('matches every VM mainnet and testnet activation', function () {
        const indexer = indexerActivation();
        if (!verdict.usable)
            return skipOrFail(this, verdict, 'the optional-chain activation parity witness');

        const vmActivation = require(verdict.path).LINT_OPTIONAL_CHAIN_ACTIVATION;
        for (const coinKey of COIN_KEYS) {
            const vmHeight = vmActivation[coinKey];
            if (vmHeight === null) {
                assert.strictEqual(indexer[coinKey], UNARMED, coinKey + ' must pair VM null with indexer UNARMED');
                continue;
            }
            assert.ok(Number.isFinite(vmHeight), coinKey + ' VM activation must be null or a finite height');
            assert.strictEqual(indexer[coinKey], vmHeight, coinKey + ' activation drifted from the VM');
        }
    });

    it('keeps the indexer regtest activation at genesis', function () {
        try {
            assert.strictEqual(indexerActivation().regtest, 0);
        } catch (error) {
            if (error.name !== 'RegistryMissError') throw error;
            assert.strictEqual(error.key, 'vm_lint_optional_chain_heights.VM_LINT_OPTIONAL_CHAIN_ACTIVATION');
        }
    });
});
