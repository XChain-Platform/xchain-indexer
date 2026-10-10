'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');
const path = require('path');
const { siblingCheckout, skipOrFail } = require('../../helpers/sibling_checkout.js');
const { UNARMED } = require('../../../src/protocol_changes/shared_rows.js');

const VM_MODULE = 'src/index/lint_banned_with_heights.js';
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
    return require('../../../src/consensus/gate_registry')
        .copy('vm_lint_banned_with_heights.VM_LINT_BANNED_WITH_ACTIVATION');
}

describe('consensus/vm_lint_banned_with_matches_vm: VM activation map @regression @tier1', function () {
    it('matches every VM mainnet and testnet activation', function () {
        const indexer = indexerActivation();
        if (!verdict.usable)
            return skipOrFail(this, verdict, 'the banned-with activation map');

        const vmActivation = require(verdict.path).LINT_BANNED_WITH_ACTIVATION;
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
        assert.strictEqual(indexerActivation().regtest, 0);
    });
});
