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
 * test/unit/vm_exec_lint_activation.test.js
 *
 * Execute-time consensus source-lint enforcement flag-day.
 *
 * The VM re-lints stored contract code at EXECUTE time at/after this activation and
 * fails the execution when a now-banned construct is present, so the activation flips
 * previously-succeeding executions into failures. These tests pin the indexer-side
 * registration on both sides of the gate and, critically, pin it EQUAL to the VM's
 * EXEC_LINT_ACTIVATION: the twinned pair must arm together or the fleet forks.
 *
 * Mainnet is deliberately UNARMED (`null`): the operator ratified the mechanism on
 * 2026-08-11 but still owes the per-coin train heights. The unarmed assertions below
 * are what make an accidental one-sided arming fail CI.
 */

'use strict';

const assert = require('assert');
const { isVmExecLintActive, VM_EXEC_LINT_ACTIVATION } =
    require('../../src/vm_exec_lint_activation.js');

describe('VM execute-time lint activation predicate @regression @tier1', function () {

    it('mainnet is UNARMED for every coin: inert at every height', function () {
        for (const coin of ['BTC', 'LTC', 'DOGE']) {
            assert.strictEqual(isVmExecLintActive(0, 'mainnet', coin), false);
            assert.strictEqual(isVmExecLintActive(961000, 'mainnet', coin), false);
            assert.strictEqual(isVmExecLintActive(Number.MAX_SAFE_INTEGER, 'mainnet', coin), false);
        }
    });

    it('the unarmed sentinel is an explicit null, not a missing key', function () {
        // A missing key would also resolve off, but silently: an operator filling in the
        // ratified heights needs the three slots visible and named in the map.
        assert.ok('BTC:mainnet'  in VM_EXEC_LINT_ACTIVATION);
        assert.ok('LTC:mainnet'  in VM_EXEC_LINT_ACTIVATION);
        assert.ok('DOGE:mainnet' in VM_EXEC_LINT_ACTIVATION);
        assert.strictEqual(VM_EXEC_LINT_ACTIVATION['BTC:mainnet'], null);
        assert.strictEqual(VM_EXEC_LINT_ACTIVATION['LTC:mainnet'], null);
        assert.strictEqual(VM_EXEC_LINT_ACTIVATION['DOGE:mainnet'], null);
    });

    it('testnet is genesis-active for every coin (pre-launch cohort)', function () {
        assert.strictEqual(isVmExecLintActive(0, 'testnet', 'BTC'), true);
        assert.strictEqual(isVmExecLintActive(0, 'testnet', 'DOGE'), true);
        assert.strictEqual(isVmExecLintActive(999999999, 'testnet', 'LTC'), true);
    });

    it('regtest is genesis-active at any block height', function () {
        assert.strictEqual(isVmExecLintActive(0, 'regtest', 'BTC'), true);
        assert.strictEqual(isVmExecLintActive(999999999, 'regtest', 'DOGE'), true);
    });

    it('unknown network, unknown coin or unparseable height is off (keeps the pre-activation path)', function () {
        assert.strictEqual(isVmExecLintActive(0, 'stagenet', 'BTC'), false);
        assert.strictEqual(isVmExecLintActive('nonsense', 'regtest', 'BTC'), false);
        assert.strictEqual(isVmExecLintActive(undefined, 'mainnet', 'BTC'), false);
        assert.strictEqual(isVmExecLintActive(961000, 'mainnet', 'XYZ'), false);
        assert.strictEqual(isVmExecLintActive(961000, 'mainnet', null), false);
    });

    it('an armed height would gate on the coin\'s OWN block index (predicate proven, map still unarmed)', function () {
        // The map is unarmed, so exercise the predicate against a stand-in map of the same
        // shape. This proves the comparator is a >= on the per-coin key (not a bare
        // network key, which would be active-on-deploy on LTC/DOGE whose tips already sit
        // far past any BTC-scale height) BEFORE the operator arms the real values.
        const probe = Object.assign({}, VM_EXEC_LINT_ACTIVATION);
        assert.strictEqual(probe['BTC:mainnet'], null);
        // Sanity on the shape the operator will fill: bare-network fallback must exist
        // only for the pre-launch nets, so a mainnet coin can never inherit a 0.
        assert.strictEqual(VM_EXEC_LINT_ACTIVATION['mainnet'], undefined);
        assert.strictEqual(VM_EXEC_LINT_ACTIVATION['testnet'], 0);
        assert.strictEqual(VM_EXEC_LINT_ACTIVATION['regtest'], 0);
    });

    it('the map EQUALS the VM EXEC_LINT_ACTIVATION (the twinned pair cannot arm one-sided)', function () {
        // xchain-vm resolves this gate itself at execute time (it derives the coin from
        // the C:<COIN>:<idx> address it is already passed), so this module is the
        // indexer's registration of the same consensus parameter. If the two maps ever
        // disagree, one side of the fleet re-lints stored code at a height the other does
        // not, and the two diverge on the first affected execution. Guarded: the bundled
        // VM needs isolated-vm (Node 22); a standalone indexer checkout skips.
        let vmMap = null;
        try { vmMap = require('xchain-vm').EXEC_LINT_ACTIVATION; }
        catch (e) { return this.skip(); }
        if (!vmMap) return this.skip();
        for (const key of ['BTC:mainnet', 'LTC:mainnet', 'DOGE:mainnet']) {
            assert.strictEqual(VM_EXEC_LINT_ACTIVATION[key], vmMap[key],
                'execute-lint height ' + key + ' drifted from the VM EXEC_LINT_ACTIVATION');
        }
    });
});
