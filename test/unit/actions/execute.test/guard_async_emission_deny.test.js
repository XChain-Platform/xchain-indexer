// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// A controller guard that emits SLASH, ATTEST or XCALL is denied host-side:
// nothing is written and the guard savepoint rolls back. For SLASH the host
// check in guard_effects.js is the only barrier, since contract.slash in the
// VM has no guard check, so deleting that check must fail here.

'use strict';

const assert = require('assert');

const { commitGuardEffects } = require('../../../../src/actions/execute/guard_effects.js');

// Build an EXECUTE-handler stand-in that records every DB write and savepoint call.
function makeHandler() {
    const calls = [];
    const indexerDb = {
        createSavepoint: async (name) => { calls.push(['createSavepoint', name]); return name; },
        releaseSavepoint: async (name) => { calls.push(['releaseSavepoint', name]); },
        rollbackToSavepoint: async (name) => { calls.push(['rollbackToSavepoint', name]); },
        createContractState: async () => { calls.push(['createContractState']); },
        countContractEmissionsForExecution: async () => 0,
        createContractExecution: async () => { calls.push(['createContractExecution']); },
        createContractEmission: async (row) => { calls.push(['createContractEmission', row.EMITTED_ACTION]); },
    };
    const handler = {
        indexerDb,
        guardSavepointCounter: 0,
        processEmission: async (emission) => { calls.push(['processEmission', emission.action]); },
    };
    return { handler, calls };
}

// Build a guard ctx whose VM result carries the given emissions.
function makeCtx(emittedActions) {
    return {
        hostData: { ACTION_INDEX: 10, BLOCK_INDEX: 321, BLOCK_TIME: 1700000000,
                    SOURCE: 'src', TX_HASH: 'aa', TX_INDEX: 1, TX_VOUT: 0 },
        opts: { seq: 0 },
        contractIndex: 7,
        guardRootDiscrim: '0',
        derived: 'contract-address',
        callDepth: 1,
        guardMethod: 'onSend',
        guardParams: ['a'],
        gasBilled: 100,
        guardCeiling: 1000,
        vmResult: { stateChanges: [], stateDeletes: [], emittedActions },
    };
}

describe('controller guard async and slash emission deny @regression @tier1', function () {
    for (const action of ['SLASH', 'ATTEST', 'XCALL']) {
        it('denies a guard that emits ' + action + ' and rolls its savepoint back', async function () {
            const { handler, calls } = makeHandler();
            const ctx = makeCtx([{ action, params: {} }]);
            const verdict = await commitGuardEffects.call(handler, ctx);
            assert.ok(verdict, 'a guard emitting ' + action + ' was allowed');
            assert.strictEqual(verdict.allow, false);
            assert.ok(verdict.reason.indexOf('guard emission not allowed: ' + action) !== -1, verdict.reason);
            assert.strictEqual(verdict.gasBilled, 100);
            const names = calls.map((c) => c[0]);
            assert.ok(names.includes('rollbackToSavepoint'), 'the guard savepoint was not rolled back');
            assert.ok(!names.includes('releaseSavepoint'), 'the guard savepoint was released');
            assert.ok(!names.includes('processEmission'), 'the forbidden emission was processed');
            assert.ok(!names.includes('createContractEmission'), 'the forbidden emission was recorded');
        });
    }

    it('commits a guard whose emissions are all allowed (control)', async function () {
        const { handler, calls } = makeHandler();
        const ctx = makeCtx([{ action: 'SEND', params: {} }]);
        const verdict = await commitGuardEffects.call(handler, ctx);
        assert.strictEqual(verdict, null);
        const names = calls.map((c) => c[0]);
        assert.ok(names.includes('releaseSavepoint'));
        assert.ok(!names.includes('rollbackToSavepoint'));
        assert.deepStrictEqual(calls.filter((c) => c[0] === 'createContractEmission'), [['createContractEmission', 'SEND']]);
    });
});
