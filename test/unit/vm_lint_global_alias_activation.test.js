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
 * test/unit/vm_lint_global_alias_activation.test.js
 *
 * Deploy-lint global-alias flag-day predicate.
 *
 * The epoch widens the banned-async and banned-wasm deploy rules to match the
 * global reads they used to walk past (sloppy-mode `this`, and the global
 * object's own `globalThis` self-reference at any depth). That changes which
 * contracts the chain accepts, so it must be height-gated, and it cannot ride
 * either existing gate: VM_LINT_HARDENING is already open on every network and
 * the Package 3 heights are in the past, so reusing either would retroactively
 * reject contracts already accepted.
 *
 * Mainnet is still UNARMED (explicit null sentinel) pending the operator's
 * ratified per-coin train heights. The assertions below are what make an
 * accidental one-sided arming fail CI.
 */

'use strict';

const assert = require('assert');
const { isVmLintGlobalAliasActive, VM_LINT_GLOBAL_ALIAS_ACTIVATION } =
    require('../../src/vm_lint_global_alias_activation.js');

describe('VM deploy-lint global-alias activation predicate @regression @tier1', function () {

    it('mainnet is UNARMED for every coin: inert at every height', function () {
        for (const coin of ['BTC', 'LTC', 'DOGE']) {
            assert.strictEqual(isVmLintGlobalAliasActive(0, 'mainnet', coin), false);
            assert.strictEqual(isVmLintGlobalAliasActive(961000, 'mainnet', coin), false);
            assert.strictEqual(isVmLintGlobalAliasActive(Number.MAX_SAFE_INTEGER, 'mainnet', coin), false);
        }
    });

    it('the unarmed sentinel is an explicit null, not a missing key', function () {
        // A missing key would also resolve off, but silently: an operator filling in the
        // ratified heights needs the three slots visible and named in the map.
        assert.ok('BTC:mainnet'  in VM_LINT_GLOBAL_ALIAS_ACTIVATION);
        assert.ok('LTC:mainnet'  in VM_LINT_GLOBAL_ALIAS_ACTIVATION);
        assert.ok('DOGE:mainnet' in VM_LINT_GLOBAL_ALIAS_ACTIVATION);
        assert.strictEqual(VM_LINT_GLOBAL_ALIAS_ACTIVATION['BTC:mainnet'], null);
        assert.strictEqual(VM_LINT_GLOBAL_ALIAS_ACTIVATION['LTC:mainnet'], null);
        assert.strictEqual(VM_LINT_GLOBAL_ALIAS_ACTIVATION['DOGE:mainnet'], null);
    });

    it('testnet and regtest are genesis-active (pre-launch cohort)', function () {
        assert.strictEqual(isVmLintGlobalAliasActive(0, 'testnet', 'BTC'), true);
        assert.strictEqual(isVmLintGlobalAliasActive(999999999, 'testnet', 'LTC'), true);
        assert.strictEqual(isVmLintGlobalAliasActive(0, 'regtest', 'BTC'), true);
        assert.strictEqual(isVmLintGlobalAliasActive(999999999, 'regtest', 'DOGE'), true);
    });

    it('unknown network, unknown coin or unparseable height is off (keeps the pre-activation verdict)', function () {
        assert.strictEqual(isVmLintGlobalAliasActive(0, 'stagenet', 'BTC'), false);
        assert.strictEqual(isVmLintGlobalAliasActive('nonsense', 'regtest', 'BTC'), false);
        assert.strictEqual(isVmLintGlobalAliasActive(undefined, 'mainnet', 'BTC'), false);
        assert.strictEqual(isVmLintGlobalAliasActive(961000, 'mainnet', 'XYZ'), false);
        assert.strictEqual(isVmLintGlobalAliasActive(961000, 'mainnet', null), false);
    });

    it('no bare mainnet key exists, so a mainnet coin can never inherit a 0', function () {
        // LTC (~3.1M) and DOGE (~6.3M) tips already sit far past any BTC-scale height, so
        // a bare-network fallback on mainnet would read as active-on-deploy there.
        assert.strictEqual(VM_LINT_GLOBAL_ALIAS_ACTIVATION['mainnet'], undefined);
        assert.strictEqual(VM_LINT_GLOBAL_ALIAS_ACTIVATION['testnet'], 0);
        assert.strictEqual(VM_LINT_GLOBAL_ALIAS_ACTIVATION['regtest'], 0);
    });

    it('the map EQUALS the VM LINT_GLOBAL_ALIAS_ACTIVATION (the twinned pair cannot arm one-sided)', function () {
        // xchain-vm resolves the same gate at execute time (it derives the coin from the
        // C:<COIN>:<idx> address it is already passed), so this module is the indexer's
        // registration of the same consensus parameter. If the two maps ever disagree, one
        // side of the fleet blocks a deploy the other accepts. Guarded: the bundled VM
        // needs isolated-vm (Node 22); a standalone indexer checkout skips.
        let vmMap = null;
        try { vmMap = require('xchain-vm').LINT_GLOBAL_ALIAS_ACTIVATION; }
        catch (e) { return this.skip(); }
        if (!vmMap) return this.skip();
        for (const key of ['BTC:mainnet', 'LTC:mainnet', 'DOGE:mainnet']) {
            assert.strictEqual(VM_LINT_GLOBAL_ALIAS_ACTIVATION[key], vmMap[key],
                'global-alias height ' + key + ' drifted from the VM LINT_GLOBAL_ALIAS_ACTIVATION');
        }
    });
});
