// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// EXECUTE runs that reach the VM: the call it receives, how state and gas
// settle, and how a reverted or failed run is recorded and rolled back. Split
// from ../execute.test.js by behaviour.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const Execute = require('../../../../src/actions/execute/index.js');
const { SOURCE, CONTRACT, makeVm, executeData, buildExecute } = require('./helpers/fixture.js');

// Rebuilt by setUp before every test. Module-level so the same-title sibling
// suites below, split only to fit the function-length limit with every full
// test title unchanged, share one fixture.
let indexer, actionsCtx, handler;

function setUp() {
    ({ indexer, actionsCtx, handler } = buildExecute());
}

function tearDown() {
    sinon.restore();
}

describe('Execute (EXECUTE) @regression @tier2', function () {
    beforeEach(setUp);
    afterEach(tearDown);

    // ─── Valid execution (with VM) ────────────────────────────────────────

    describe('valid execution with VM', function () {
        it('vm.execute called with correct method and params', async function () {
            const vm = makeVm();
            actionsCtx.vm = vm;
            handler = new Execute(actionsCtx);

            const data = executeData({ FORMAT: 0 });
            await handler.parse(['0', String(CONTRACT), 'transfer', 'recipient', '50'], data, null);

            assert.ok(vm.execute.calledOnce);
            const callArgs = vm.execute.firstCall.args[0];
            assert.strictEqual(callArgs.method, 'transfer');
            assert.deepStrictEqual(callArgs.params, ['recipient', '50']);
        });

        it('STATUS is valid on successful VM execution', async function () {
            actionsCtx.vm = makeVm();
            handler = new Execute(actionsCtx);

            const data = executeData({ FORMAT: 0 });
            await handler.parse(['0', String(CONTRACT), 'run', ''], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
        });

        it('applies state changes via createContractState', async function () {
            actionsCtx.vm = makeVm({
                execute: sinon.stub().resolves({
                    success: true,
                    gasUsed: 50,
                    stateChanges:   [{ key: 'foo', value: 'bar' }],
                    stateDeletes:   [],
                    emittedActions: [],
                }),
            });
            handler = new Execute(actionsCtx);

            const data = executeData({ FORMAT: 0 });
            await handler.parse(['0', String(CONTRACT), 'run', ''], data, null);
            assert.ok(indexer.indexerDb.createContractState.calledOnce);
        });
    });
});

describe('Execute (EXECUTE) @regression @tier2', function () {
    beforeEach(setUp);
    afterEach(tearDown);

    describe('valid execution with VM', function () {
        it('applies state deletes via createContractState with null value', async function () {
            actionsCtx.vm = makeVm({
                execute: sinon.stub().resolves({
                    success: true,
                    gasUsed: 50,
                    stateChanges:   [],
                    stateDeletes:   ['oldKey'],
                    emittedActions: [],
                }),
            });
            handler = new Execute(actionsCtx);

            const data = executeData({ FORMAT: 0 });
            await handler.parse(['0', String(CONTRACT), 'run', ''], data, null);
            assert.ok(indexer.indexerDb.createContractState.calledOnce);
            const stateArg = indexer.indexerDb.createContractState.firstCall.args[0];
            assert.strictEqual(stateArg.STATE_VALUE, null);
        });

        // A clamp that fires only for a resource TERMINATION is not enough, since a success result
        // reporting more gas than the run's ceiling would bill unclamped: the gas tracker adds a
        // charge to `used` before deciding it exhausted the limit, so a swallowed charge-site
        // throw returns success one charge over. The settlement's own stated bound
        // (0 <= gasBilled <= gasUsed <= execCeiling) has to be enforced, not assumed.
        it('clamps an over-ceiling SUCCESS gasUsed to the protocol ceiling', async function () {
            actionsCtx.vm = makeVm({
                execute: sinon.stub().resolves({
                    success: true,
                    gasUsed: 1000000 + 4096,       // GAS_CEILING plus one charge
                    stateChanges: [], stateDeletes: [], emittedActions: [],
                }),
            });
            handler = new Execute(actionsCtx);

            const data = executeData({ FORMAT: 0 });
            await handler.parse(['0', String(CONTRACT), 'run', ''], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(data['VM_GAS_BILLED'], 1000000);
        });
    });
});

describe('Execute (EXECUTE) @regression @tier2', function () {
    beforeEach(setUp);
    afterEach(tearDown);

    describe('valid execution with VM', function () {
        // A cross-contract callee settles against its CALLER-FUNDED reservation, not the
        // protocol ceiling, and the parent's refund reads execCeiling - gasBilled: an
        // unclamped callee both overbills and zeroes out the parent's refund.
        it('clamps an over-ceiling SUCCESS to the caller-funded reservation, not the protocol ceiling', async function () {
            actionsCtx.vm = makeVm({
                execute: sinon.stub().resolves({
                    success: true,
                    gasUsed: 60000,
                    stateChanges: [], stateDeletes: [], emittedActions: [],
                }),
            });
            handler = new Execute(actionsCtx);

            const data = executeData({ FORMAT: 0, IS_EMISSION: true, VM_GAS_LIMIT: 50000 });
            await handler.parse(['0', String(CONTRACT), 'run', ''], data, null);
            assert.strictEqual(data['VM_GAS_BILLED'], 50000);
            assert.strictEqual(data['VM_GAS_UNUSED_SUBTREE'], 0);
        });

    });
});

describe('Execute (EXECUTE) @regression @tier2', function () {
    beforeEach(setUp);
    afterEach(tearDown);

    // ─── VM failure paths ─────────────────────────────────────────────────

    describe('VM failure paths', function () {
        it('normalises a revert to a stable status token (not raw error string)', async function () {
            actionsCtx.vm = makeVm({
                execute: sinon.stub().resolves({
                    success: false,
                    error:   'revert: unauthorised caller',
                    gasUsed: 200,
                    stateChanges: [], stateDeletes: [], emittedActions: [],
                }),
            });
            handler = new Execute(actionsCtx);

            const data = executeData({ FORMAT: 0 });
            await handler.parse(['0', String(CONTRACT), 'run', ''], data, null);
            // Status should be a stable token (reverted) not a raw VM string
            assert.strictEqual(data['STATUS'], 'reverted',
                'revert must map to the stable "reverted" consensus token');
        });

        it('normalises out_of_gas to out_of_resource', async function () {
            actionsCtx.vm = makeVm({
                execute: sinon.stub().resolves({
                    success: false,
                    error:   'out_of_gas',
                    gasUsed: 1000000,
                    stateChanges: [], stateDeletes: [], emittedActions: [],
                }),
            });
            handler = new Execute(actionsCtx);

            const data = executeData({ FORMAT: 0 });
            await handler.parse(['0', String(CONTRACT), 'run', ''], data, null);
            assert.strictEqual(data['STATUS'], 'out_of_resource');
        });

        it('still calls createContractExecution on VM failure', async function () {
            actionsCtx.vm = makeVm({
                execute: sinon.stub().resolves({
                    success: false, error: 'revert', gasUsed: 100,
                    stateChanges: [], stateDeletes: [], emittedActions: [],
                }),
            });
            handler = new Execute(actionsCtx);

            const data = executeData({ FORMAT: 0 });
            await handler.parse(['0', String(CONTRACT), 'run', ''], data, null);
            assert.ok(indexer.indexerDb.createContractExecution.calledOnce);
        });
    });
});

describe('Execute (EXECUTE) @regression @tier2', function () {
    beforeEach(setUp);
    afterEach(tearDown);

    describe('VM failure paths', function () {
        it('rolls back state changes on emission failure', async function () {
            // VM succeeds but the emission handler throws
            actionsCtx.vm = makeVm({
                execute: sinon.stub().resolves({
                    success: true,
                    gasUsed: 100,
                    stateChanges:   [{ key: 'k', value: 'v' }],
                    stateDeletes:   [],
                    emittedActions: [{ action: 'SEND', params: { tick: 'TEST', quantity: '1', destination: SOURCE } }],
                }),
            });

            // Cause savepoint write to throw (simulating emission failure)
            indexer.indexerDb.createContractState.rejects(new Error('db gone'));
            handler = new Execute(actionsCtx);

            const data = executeData({ FORMAT: 0 });
            await handler.parse(['0', String(CONTRACT), 'run', ''], data, null);
            // Must have called rollbackToSavepoint after the failure
            assert.ok(indexer.indexerDb.rollbackToSavepoint.calledOnce);
        });

    });
});
