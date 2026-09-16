// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Cross-contract calls (emit.execute): the path, depth and gas a callee
// inherits, how its refund nets out of the caller's bill, and how a failed
// callee rolls the tree back. Split from ../execute.test.js by behaviour.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const Execute = require('../../../../src/actions/execute/index.js');
const { CONTRACT, makeVm, executeData, buildExecute } = require('./helpers/fixture.js');

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

const CALLEE = 7;

function emitExecute(overrides = {}) {
    return { action: 'EXECUTE', params: { contractIndex: CALLEE, method: 'onPing', params: ['x'], gasLimit: 50000, ...overrides } };
}

describe('Execute (EXECUTE) @regression @tier2', function () {
    beforeEach(setUp);
    afterEach(tearDown);

    // ─── Cross-contract calls (emit.execute) ──────────────────────────────
    describe('cross-contract calls', function () {
        it('getActionHandler routes EXECUTE to the wired actionExecute', function () {
            actionsCtx.actionExecute = { parse: sinon.stub() };
            handler = new Execute(actionsCtx);
            assert.strictEqual(handler.getActionHandler('EXECUTE'), actionsCtx.actionExecute);
        });

        it('processEmission threads depth, gasLimit and the deterministic call-path to the callee', async function () {
            const calleeHandler = { parse: sinon.stub().callsFake(async (params, data) => { data['STATUS'] = 'valid'; }) };
            actionsCtx.actionExecute = calleeHandler;
            handler = new Execute(actionsCtx);

            // Parent execution sits at call-path '2'; this is its emission #0, so the
            // callee's own execution path is '2>0' and the callee re-derives any of its
            // own request_ids against EMITTER_PATH = its execution path.
            const execData = executeData({ CONTRACT_ACTION_INDEX: CONTRACT, ACTION_INDEX: 11, CALL_DEPTH: 1, CALL_PATH: '2' });
            await handler.processEmission(emitExecute(), execData, 0);

            assert.ok(calleeHandler.parse.calledOnce);
            const [params, data] = calleeHandler.parse.firstCall.args;
            assert.deepStrictEqual(params, [0, CALLEE, 'onPing', 'x']);
            assert.strictEqual(data['CALL_DEPTH'], 2);                      // parent depth + 1
            assert.strictEqual(data['VM_GAS_LIMIT'], 50000);                // caller-funded ceiling
            assert.strictEqual(data['EMITTER_PATH'], '2');                  // the emitting execution's path
            assert.strictEqual(data['CALL_PATH'], '2>0');                   // the callee's own execution path
            assert.strictEqual(data['IS_EMISSION'], true);
            assert.strictEqual(data['SOURCE'], 'C:' + indexer.config['CHAIN'] + ':' + CONTRACT);
        });

        it('a callee run uses VM_GAS_LIMIT as its VM ceiling and reports its unused subtree gas', async function () {
            const vm = makeVm({
                execute: sinon.stub().resolves({
                    success: true, gasUsed: 20000,
                    stateChanges: [], stateDeletes: [], emittedActions: [],
                }),
            });
            actionsCtx.vm = vm;
            handler = new Execute(actionsCtx);

            const data = executeData({ IS_EMISSION: true, VM_GAS_LIMIT: 50000, CALL_DEPTH: 1, ACTION_INDEX: 12 });
            await handler.parse(['0', String(CONTRACT), 'run', ''], data, null);

            const vmArgs = vm.execute.firstCall.args[0];
            assert.strictEqual(vmArgs.gasCeiling, 50000);
            assert.strictEqual(vmArgs.callDepth, 1);
            assert.strictEqual(vmArgs.actionIndex, 12);

            // billed 20000 of the 50000 reservation -> 30000 flows back to the parent
            assert.strictEqual(data['VM_GAS_UNUSED_SUBTREE'], 30000);
            const row = indexer.indexerDb.createContractExecution.firstCall.args[0];
            assert.strictEqual(row['GAS_USED'], 20000);
            assert.strictEqual(row['GAS_LIMIT'], 50000);
        });
    });
});

describe('Execute (EXECUTE) @regression @tier2', function () {
    beforeEach(setUp);
    afterEach(tearDown);

    describe('cross-contract calls', function () {
        it('a top-level run nets callee refunds out of its billed gas', async function () {
            // Caller metered 60000 (incl. the 500+50000 reservation); the callee
            // hands back 30000 unused -> billed 30000.
            actionsCtx.vm = makeVm({
                execute: sinon.stub().resolves({
                    success: true, gasUsed: 60000,
                    stateChanges: [], stateDeletes: [],
                    emittedActions: [emitExecute()],
                }),
            });
            actionsCtx.actionExecute = { parse: sinon.stub().callsFake(async (params, data) => {
                data['STATUS'] = 'valid';
                data['VM_GAS_UNUSED_SUBTREE'] = 30000;
            }) };
            handler = new Execute(actionsCtx);

            const data = executeData({ ACTION_INDEX: 13 });
            await handler.parse(['0', String(CONTRACT), 'run', ''], data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            const row = indexer.indexerDb.createContractExecution.firstCall.args[0];
            assert.strictEqual(row['GAS_USED'], 30000, 'billed = 60000 metered - 30000 refunded');
            assert.strictEqual(row['GAS_LIMIT'], 1000000);
            assert.ok(indexer.indexerDb.createContractEmission.calledOnce);
        });

        it('uses an execution-unique savepoint name (nested savepoints must not collide)', async function () {
            actionsCtx.vm = makeVm();
            handler = new Execute(actionsCtx);

            const data = executeData({ ACTION_INDEX: 14 });
            await handler.parse(['0', String(CONTRACT), 'run', ''], data, null);
            assert.ok(indexer.indexerDb.createSavepoint.calledWith('vm_execute_14'),
                'got: ' + JSON.stringify(indexer.indexerDb.createSavepoint.firstCall.args));
        });
    });
});

describe('Execute (EXECUTE) @regression @tier2', function () {
    beforeEach(setUp);
    afterEach(tearDown);

    describe('cross-contract calls', function () {
        it('a failed callee rolls back the tree and forfeits all refunds', async function () {
            actionsCtx.vm = makeVm({
                execute: sinon.stub().resolves({
                    success: true, gasUsed: 60000,
                    stateChanges: [], stateDeletes: [],
                    emittedActions: [emitExecute()],
                }),
            });
            actionsCtx.actionExecute = { parse: sinon.stub().callsFake(async (params, data) => {
                data['STATUS'] = 'out_of_resource';
            }) };
            handler = new Execute(actionsCtx);

            const data = executeData({ ACTION_INDEX: 15 });
            await handler.parse(['0', String(CONTRACT), 'run', ''], data, null);

            assert.ok(indexer.indexerDb.rollbackToSavepoint.calledOnce);
            assert.strictEqual(data['STATUS'], 'failed'); // 'emission failed: ...' -> failed token
            const row = indexer.indexerDb.createContractExecution.firstCall.args[0];
            assert.strictEqual(row['GAS_USED'], 60000, 'no refunds on a failed tree');
        });
    });

    describe('cross-contract calls', function () {
        it('clamps a resource-terminated callee to ITS reservation, not the protocol ceiling', async function () {
            actionsCtx.vm = makeVm({
                execute: sinon.stub().resolves({
                    success: false, error: 'out_of_gas: used 999999 of 50000', gasUsed: 999999,
                    stateChanges: [], stateDeletes: [], emittedActions: [],
                }),
            });
            handler = new Execute(actionsCtx);

            const data = executeData({ IS_EMISSION: true, VM_GAS_LIMIT: 50000, CALL_DEPTH: 1, ACTION_INDEX: 16 });
            await handler.parse(['0', String(CONTRACT), 'run', ''], data, null);

            const row = indexer.indexerDb.createContractExecution.firstCall.args[0];
            assert.strictEqual(row['GAS_USED'], 50000, 'defense-in-depth clamp must use the per-call ceiling');
            assert.strictEqual(data['STATUS'], 'out_of_resource');
        });

        it('system-injected callbacks (IS_EMISSION without VM_GAS_LIMIT) keep the protocol ceiling', async function () {
            const vm = makeVm();
            actionsCtx.vm = vm;
            handler = new Execute(actionsCtx);

            const data = executeData({ IS_EMISSION: true, ACTION_INDEX: 17 });
            await handler.parse(['0', String(CONTRACT), 'run', ''], data, null);
            assert.strictEqual(vm.execute.firstCall.args[0].gasCeiling, 1000000);
        });
    });
});
