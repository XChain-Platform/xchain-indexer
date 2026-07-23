/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/vm_deploy_lint_pkg3_activation.test.js
 *
 * VM deploy-lint Package 3 flag-day (29912bd8 generator ban + 75190596 wasm ban,
 * deploy half). The deploy verdict switches from accepting a generator/WebAssembly
 * contract to rejecting it at the ratified per-coin deploy-train heights. These
 * tests pin the activation-module predicate both sides of the gate: mainnet per-coin
 * boundary, testnet + regtest genesis, unknown/bad input off; and pin the heights to
 * the VM's PKG3_SANDBOX_ACTIVATION so the deploy-lint gate cannot drift from the
 * runtime-strip gate (a divergence would fork the fleet).
 */

'use strict';

const assert = require('assert');
const { isVmDeployLintPkg3Active, VM_DEPLOY_LINT_PKG3_ACTIVATION } =
    require('../../src/vm_deploy_lint_pkg3_activation.js');

describe('VM deploy-lint Pkg 3 activation predicate (generator + wasm bans) @regression @tier1', function () {

    it('mainnet is armed per coin: inert below the height, active at/after it', function () {
        assert.strictEqual(isVmDeployLintPkg3Active(960999, 'mainnet', 'BTC'), false);
        assert.strictEqual(isVmDeployLintPkg3Active(961000, 'mainnet', 'BTC'), true);
        assert.strictEqual(isVmDeployLintPkg3Active(3154249, 'mainnet', 'LTC'), false);
        assert.strictEqual(isVmDeployLintPkg3Active(3154250, 'mainnet', 'LTC'), true);
        assert.strictEqual(isVmDeployLintPkg3Active(6318999, 'mainnet', 'DOGE'), false);
        assert.strictEqual(isVmDeployLintPkg3Active(6319000, 'mainnet', 'DOGE'), true);
    });

    it('is per-coin, not a bare BTC height: LTC/DOGE mainnet at 961000 stay inert', function () {
        // A bare 961000 gate would be active-on-deploy on LTC (~3.1M tip) and DOGE
        // (~6.3M tip), violating byte-identical-below there. The per-coin map fixes it.
        assert.strictEqual(isVmDeployLintPkg3Active(961000, 'mainnet', 'LTC'), false);
        assert.strictEqual(isVmDeployLintPkg3Active(961000, 'mainnet', 'DOGE'), false);
    });

    it('testnet is genesis-active for every coin (pre-launch cohort)', function () {
        assert.strictEqual(isVmDeployLintPkg3Active(0, 'testnet', 'BTC'), true);
        assert.strictEqual(isVmDeployLintPkg3Active(0, 'testnet', 'DOGE'), true);
        assert.strictEqual(isVmDeployLintPkg3Active(999999999, 'testnet', 'LTC'), true);
    });

    it('regtest is genesis-active at any block height', function () {
        assert.strictEqual(isVmDeployLintPkg3Active(0, 'regtest', 'BTC'), true);
        assert.strictEqual(isVmDeployLintPkg3Active(999999999, 'regtest', 'DOGE'), true);
    });

    it('unknown network or unparseable height is off (safe: keeps pre-activation accepted verdict)', function () {
        assert.strictEqual(isVmDeployLintPkg3Active(0, 'stagenet', 'BTC'), false);
        assert.strictEqual(isVmDeployLintPkg3Active('nonsense', 'regtest', 'BTC'), false);
        assert.strictEqual(isVmDeployLintPkg3Active(undefined, 'mainnet', 'BTC'), false);
        assert.strictEqual(isVmDeployLintPkg3Active(961000, 'mainnet', 'XYZ'), false);
    });

    it('the ratified per-coin train heights are pinned in the map', function () {
        assert.strictEqual(VM_DEPLOY_LINT_PKG3_ACTIVATION['BTC:mainnet'], 961000);
        assert.strictEqual(VM_DEPLOY_LINT_PKG3_ACTIVATION['LTC:mainnet'], 3154250);
        assert.strictEqual(VM_DEPLOY_LINT_PKG3_ACTIVATION['DOGE:mainnet'], 6319000);
        assert.strictEqual(VM_DEPLOY_LINT_PKG3_ACTIVATION['testnet'], 0);
        assert.strictEqual(VM_DEPLOY_LINT_PKG3_ACTIVATION['regtest'], 0);
    });

    it('heights EQUAL the VM PKG3_SANDBOX_ACTIVATION (deploy-lint gate cannot drift from the runtime strip)', function () {
        // The deploy-lint bans (this module) and the VM runtime strips (WebAssembly
        // global delete, etc.) are the two halves of ONE Package 3 bundle; if they
        // armed at different heights there would be a window where a wasm-referencing
        // contract deploys clean but has WebAssembly stripped at execution. Pin the
        // three mainnet heights equal. Guarded: the bundled VM needs isolated-vm
        // (Node 22); a standalone indexer checkout skips this coupling.
        let vmPkg3 = null;
        try { vmPkg3 = require('xchain-vm').PKG3_SANDBOX_ACTIVATION; }
        catch (e) { return this.skip(); }
        if (!vmPkg3) return this.skip();
        for (const key of ['BTC:mainnet', 'LTC:mainnet', 'DOGE:mainnet']) {
            assert.strictEqual(VM_DEPLOY_LINT_PKG3_ACTIVATION[key], vmPkg3[key],
                'deploy-lint height ' + key + ' drifted from VM PKG3_SANDBOX_ACTIVATION');
        }
    });
});
