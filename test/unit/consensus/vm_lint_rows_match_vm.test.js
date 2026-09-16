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
 **********************************************************************
 *
 * The three VM lint gates the indexer registers as its own rows are each
 * ONE HALF of a pair whose other half lives in xchain-vm: the deploy-lint
 * bans and the runtime Package 3 strips, the execute-time re-lint on both
 * sides, the global-alias refinement on both sides. If the two halves armed
 * at different heights there would be a window where one side of the fleet
 * accepts (or executes) what the other refuses, and the fleet forks on the
 * first affected contract. These cases pin each indexer row EQUAL to the VM
 * export at every mainnet coin key.
 *
 * Until W4 each case lived in the gate's own shim suite; W4 (activation
 * registry, row 18) retired those shims, so the rows are read here by their
 * registry keys, which is also what every caller now reads. Guarded: the
 * bundled VM needs isolated-vm (Node 22), so a standalone indexer checkout
 * skips rather than comparing against nothing.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const registry = require('../../../src/consensus/gate_registry');

const MAINNET_COINS = ['BTC:mainnet', 'LTC:mainnet', 'DOGE:mainnet'];

// [indexer registry key, the VM export it must equal, what a drift would mean]
const PAIRS = [
    ['vm_deploy_lint_pkg3_activation.VM_DEPLOY_LINT_PKG3_ACTIVATION', 'PKG3_SANDBOX_ACTIVATION',
        'a wasm-referencing contract deploys clean but has WebAssembly stripped at execution'],
    ['vm_exec_lint_activation.VM_EXEC_LINT_ACTIVATION', 'EXEC_LINT_ACTIVATION',
        'one side re-lints stored code at a height the other does not'],
    ['vm_lint_global_alias_activation.VM_LINT_GLOBAL_ALIAS_ACTIVATION', 'LINT_GLOBAL_ALIAS_ACTIVATION',
        'one side blocks a deploy the other accepts'],
];

function vmExport(name) {
    let vm;
    try { vm = require('xchain-vm'); } catch (e) { return null; }
    return vm && vm[name] ? vm[name] : null;
}

describe('consensus/vm_lint_rows_match_vm: each VM lint row equals its xchain-vm twin @regression @tier1', function () {
    for (const [key, vmName, drift] of PAIRS) {
        it(key + ' equals xchain-vm ' + vmName + ' at every mainnet coin key', function () {
            const vmMap = vmExport(vmName);
            if (!vmMap) return this.skip();
            const row = registry.get(key);
            for (const coinKey of MAINNET_COINS) {
                assert.strictEqual(row[coinKey], vmMap[coinKey],
                    key + ' ' + coinKey + ' drifted from the VM ' + vmName + ': ' + drift);
            }
        });
    }

    it('every pair names a registry row the callers read (a renamed key would compare nothing)', function () {
        for (const [key] of PAIRS) {
            assert.strictEqual(registry.registry.unitOf(key), 'height', key);
            assert.strictEqual(typeof registry.get(key)['BTC:mainnet'], 'number', key + ' has a BTC:mainnet height');
        }
    });
});
