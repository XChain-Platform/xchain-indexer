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
 * The epoch widens the banned-async, banned-wasm and banned-math deploy rules to
 * match the global reads they used to walk past (sloppy-mode `this`, and the global
 * object's own `globalThis` self-reference at any depth). That changes which
 * contracts the chain accepts, so it must be height-gated, and it cannot ride
 * either existing gate: VM_LINT_HARDENING is already open on every network and
 * the Package 3 heights are in the past, so reusing either would retroactively
 * reject contracts already accepted.
 *
 * Mainnet is ARMED AT GENESIS by the operator's 2026-09-09 ruling: a mainnet gate
 * that is identity on the indexed mainnet history arms at genesis rather than at a
 * train height, and this one is identity there (0 contracts, 0 DEPLOY actions on
 * mainnet, measured 2026-09-09), so there is no accepted deploy verdict the widened
 * rules can reverse. The assertions below are what make a one-sided move, in either
 * direction, fail CI.
 */

'use strict';

const assert = require('assert');
const { isVmLintGlobalAliasActive, VM_LINT_GLOBAL_ALIAS_ACTIVATION } =
    require('../../src/vm_lint_global_alias_activation.js');

describe('VM deploy-lint global-alias activation predicate @regression @tier1', function () {

    it('mainnet is ARMED AT GENESIS for every coin: active at every height', function () {
        for (const coin of ['BTC', 'LTC', 'DOGE']) {
            assert.strictEqual(isVmLintGlobalAliasActive(0, 'mainnet', coin), true);
            assert.strictEqual(isVmLintGlobalAliasActive(961000, 'mainnet', coin), true);
            assert.strictEqual(isVmLintGlobalAliasActive(Number.MAX_SAFE_INTEGER, 'mainnet', coin), true);
        }
    });

    it('the genesis height is an explicit per-coin 0, not an inherited or missing key', function () {
        // A missing key would resolve OFF and silently disarm mainnet, which is the
        // failure this pin exists to catch; the three slots stay visible and named.
        assert.ok('BTC:mainnet'  in VM_LINT_GLOBAL_ALIAS_ACTIVATION);
        assert.ok('LTC:mainnet'  in VM_LINT_GLOBAL_ALIAS_ACTIVATION);
        assert.ok('DOGE:mainnet' in VM_LINT_GLOBAL_ALIAS_ACTIVATION);
        assert.strictEqual(VM_LINT_GLOBAL_ALIAS_ACTIVATION['BTC:mainnet'], 0);
        assert.strictEqual(VM_LINT_GLOBAL_ALIAS_ACTIVATION['LTC:mainnet'], 0);
        assert.strictEqual(VM_LINT_GLOBAL_ALIAS_ACTIVATION['DOGE:mainnet'], 0);
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

    it('no bare mainnet key exists, so a mainnet coin can never inherit a height', function () {
        // Each mainnet coin carries its own key. A later re-arm that moves one coin has
        // to move that coin's key, and a coin whose key went missing resolves off rather
        // than inheriting someone else's number.
        assert.strictEqual(VM_LINT_GLOBAL_ALIAS_ACTIVATION['mainnet'], undefined);
        assert.strictEqual(VM_LINT_GLOBAL_ALIAS_ACTIVATION['testnet'], 0);
        assert.strictEqual(VM_LINT_GLOBAL_ALIAS_ACTIVATION['regtest'], 0);
        assert.strictEqual(isVmLintGlobalAliasActive(961000, 'mainnet', 'XYZ'), false);
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
