// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// DEPLOY unit suite: what a constructor run leaves behind, its state writes and
// rollback, and its emissions. One part of deploy.test.js; the shared fixtures are
// in helpers/deploy_suite.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { VALID_CODE, VALID_CODE_B64, SOURCE, makeVm, deployData, freshDeploySuite } = require('./helpers/deploy_suite.js');

const Deploy = require('../../../../../src/actions/deploy/index.js');
// The SLASH writer a constructor's emissions route through. Stubbed at the module
// seam because DEPLOY does not reach into the Execute instance for it.
const slashEmission = require('../../../../../src/actions/execute/slash_emission.js');

// The suite's fixtures. Every same-title block below runs freshSuite before
// each test, so each test starts from the same fixtures as the rest of the suite.
let indexer, actionsCtx, handler;
function freshSuite() {
    ({ indexer, actionsCtx, handler } = freshDeploySuite());
}

function wireEmissionDeps(emittedActions, vmGas = 1000) {
    indexer.indexerDb.createContractEmission = sinon.stub().resolves();
    actionsCtx.vm = makeVm({
        execute: sinon.stub().resolves({
            success: true, gasUsed: vmGas,
            stateChanges: [], stateDeletes: [],
            emittedActions,
        }),
    });
    actionsCtx.actionExecute = {
        processEmission: sinon.stub().callsFake(async (emission) => { emission.resultActionIndex = 999; }),
    };
    sinon.stub(slashEmission, 'processSlashEmission').resolves();
    handler = new Deploy(actionsCtx);
    return actionsCtx;
}

describe('Deploy (DEPLOY) @regression @tier2', function () {
    beforeEach(freshSuite);
    afterEach(function () { sinon.restore(); });

    // ─── Constructor state changes + rollback (lines 323-348) ────────────

    describe('constructor state changes and rollback', function () {
        it('constructor with stateChanges calls createContractState for each change (lines 322-330)', async function () {
            const vm = makeVm({
                execute: sinon.stub().resolves({
                    success: true,
                    gasUsed: 50,
                    stateChanges: [{ key: 'foo', value: 'bar' }, { key: 'baz', value: 42 }],
                    stateDeletes: [],
                    emittedActions: [],
                }),
            });
            actionsCtx.vm = vm;
            handler = new Deploy(actionsCtx);

            const data = deployData({ FORMAT: 0 });
            await handler.parse(['0', VALID_CODE_B64, '100000', 'initparam'], data, null);

            // createContractState called twice (once per change)
            assert.ok(indexer.indexerDb.createContractState.callCount >= 2);
            assert.strictEqual(data['STATUS'], 'valid');
        });

        it('constructor with stateDeletes calls createContractState with null value (lines 332-339)', async function () {
            const vm = makeVm({
                execute: sinon.stub().resolves({
                    success: true,
                    gasUsed: 50,
                    stateChanges: [],
                    stateDeletes: ['oldKey1', 'oldKey2'],
                    emittedActions: [],
                }),
            });
            actionsCtx.vm = vm;
            handler = new Deploy(actionsCtx);

            const data = deployData({ FORMAT: 0 });
            await handler.parse(['0', VALID_CODE_B64, '100000', 'initparam'], data, null);

            const calls = indexer.indexerDb.createContractState.args;
            const nullCalls = calls.filter(a => a[0].STATE_VALUE === null);
            assert.ok(nullCalls.length >= 2, 'should have called createContractState with null for each delete');
            assert.strictEqual(data['STATUS'], 'valid');
        });
    });
});

describe('Deploy (DEPLOY) @regression @tier2', function () {
    beforeEach(freshSuite);
    afterEach(function () { sinon.restore(); });

    describe('constructor state changes and rollback', function () {
        it('constructor state write failure rolls back savepoint and marks deploy failed (lines 341-348)', async function () {
            const vm = makeVm({
                execute: sinon.stub().resolves({
                    success: true,
                    gasUsed: 50,
                    stateChanges: [{ key: 'k', value: 'v' }],
                    stateDeletes: [],
                    emittedActions: [],
                }),
            });
            actionsCtx.vm = vm;
            // Cause createContractState to throw
            indexer.indexerDb.createContractState.rejects(new Error('disk full'));
            handler = new Deploy(actionsCtx);

            const data = deployData({ FORMAT: 0 });
            await handler.parse(['0', VALID_CODE_B64, '100000', 'initparam'], data, null);

            sinon.assert.calledOnce(indexer.indexerDb.rollbackToSavepoint);
            // deleteContract called (contract record cleaned up)
            assert.ok(indexer.indexerDb.deleteContract.called);
            assert.ok(String(data['STATUS']).includes('failed') || String(data['STATUS']).startsWith('invalid'));
        });

    });
});

describe('Deploy (DEPLOY) @regression @tier2', function () {
    beforeEach(freshSuite);
    afterEach(function () { sinon.restore(); });

    // ─── Constructor emissions (processed through the EXECUTE pipeline) ────

    describe('constructor emissions', function () {
        it('routes constructor emissions through Execute.processEmission with a root context', async function () {
            const ctx = wireEmissionDeps([{ action: 'SEND', params: { tick: 'T', quantity: '1', destination: SOURCE } }]);

            const data = deployData({ FORMAT: 0, ACTION_INDEX: 42 });
            await handler.parse(['0', VALID_CODE_B64, '100000', 'init'], data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            sinon.assert.calledOnce(ctx.actionExecute.processEmission);
            const [emission, execCtx, position] = ctx.actionExecute.processEmission.firstCall.args;
            assert.strictEqual(emission.action, 'SEND');
            assert.strictEqual(position, 0);
            assert.strictEqual(execCtx['CONTRACT_ACTION_INDEX'], 42); // the new contract emits
            assert.strictEqual(execCtx['ACTION_INDEX'], 42);          // DEPLOY is the executing action
            assert.strictEqual(execCtx['CALL_DEPTH'], 0);             // constructor = root execution
            assert.strictEqual(execCtx['SOURCE'], SOURCE);            // deployer pays fees
            // Emission link recorded against the deployment
            sinon.assert.calledOnce(indexer.indexerDb.createContractEmission);
            const link = indexer.indexerDb.createContractEmission.firstCall.args[0];
            assert.strictEqual(link['EXECUTION_INDEX'], 42);
            assert.strictEqual(link['ACTION_INDEX'], 999);
        });

        it('passes txHash / actionIndex / callDepth=0 to the constructor VM run', async function () {
            const ctx = wireEmissionDeps([]);
            const data = deployData({ FORMAT: 0, ACTION_INDEX: 7 });
            await handler.parse(['0', VALID_CODE_B64, '100000', 'init'], data, null);
            const vmArgs = ctx.vm.execute.firstCall.args[0];
            assert.strictEqual(vmArgs.txHash, data['TX_HASH']);
            assert.strictEqual(vmArgs.actionIndex, 7);
            assert.strictEqual(vmArgs.callDepth, 0);
        });
    });
});

describe('Deploy (DEPLOY) @regression @tier2', function () {
    beforeEach(freshSuite);
    afterEach(function () { sinon.restore(); });

    describe('constructor emissions', function () {

        it('nets a cross-contract callee refund out of the deployment gas', async function () {
            const ctx = wireEmissionDeps(
                [{ action: 'EXECUTE', params: { contractIndex: 9, method: 'm', gasLimit: 50000 } }],
                60000 // constructor metered gas (includes the 500+50000 reservation)
            );
            ctx.actionExecute.processEmission = sinon.stub().callsFake(async (emission) => {
                emission.resultActionIndex = 999;
                emission.gasUnusedSubtree = 30000;
            });
            handler = new Deploy(actionsCtx);

            const data = deployData({ FORMAT: 0, ACTION_INDEX: 8 });
            await handler.parse(['0', VALID_CODE_B64, '100000', 'init'], data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            const schedule = indexer.config['GAS_SCHEDULE'];
            const deployGas = schedule.VM_DEPLOY_BASE + Buffer.byteLength(VALID_CODE, 'utf8') * schedule.VM_DEPLOY_PER_BYTE;
            const row = indexer.indexerDb.createContractExecution.firstCall.args[0];
            assert.strictEqual(row['GAS_USED'], deployGas + 60000 - 30000,
                'deployment gas must net the callee refund');
        });
    });
});

describe('Deploy (DEPLOY) @regression @tier2', function () {
    beforeEach(freshSuite);
    afterEach(function () { sinon.restore(); });

    describe('constructor emissions', function () {
        it('a failed constructor emission rolls back and fails the deployment', async function () {
            const ctx = wireEmissionDeps([{ action: 'SEND', params: {} }]);
            ctx.actionExecute.processEmission = sinon.stub().rejects(new Error('SEND: invalid: insufficient funds'));
            handler = new Deploy(actionsCtx);

            const data = deployData({ FORMAT: 0, ACTION_INDEX: 9 });
            await handler.parse(['0', VALID_CODE_B64, '100000', 'init'], data, null);

            sinon.assert.calledOnce(indexer.indexerDb.rollbackToSavepoint);
            assert.ok(indexer.indexerDb.deleteContract.called);
            assert.ok(String(data['STATUS']).startsWith('invalid'));
        });

        it('routes SLASH emissions to the inline handler (never the generic router)', async function () {
            const ctx = wireEmissionDeps([{ action: 'SLASH', params: { contractIndex: 10, pubkey: 'a'.repeat(64), token: 'T', amount: '1' } }]);
            const data = deployData({ FORMAT: 0, ACTION_INDEX: 10 });
            await handler.parse(['0', VALID_CODE_B64, '100000', 'init'], data, null);
            sinon.assert.calledOnce(slashEmission.processSlashEmission);
            // Called with the DEPLOY handler as the receiver: the writer reads
            // indexerDb/util/config off it, and both handlers alias the same three.
            assert.strictEqual(slashEmission.processSlashEmission.firstCall.thisValue, handler);
            sinon.assert.notCalled(ctx.actionExecute.processEmission);
        });

        it('uses a deployment-unique savepoint name (emitted EXECUTEs nest their own)', async function () {
            wireEmissionDeps([]);
            const data = deployData({ FORMAT: 0, ACTION_INDEX: 11 });
            await handler.parse(['0', VALID_CODE_B64, '100000', 'init'], data, null);
            assert.ok(indexer.indexerDb.createSavepoint.calledWith('vm_constructor_11'),
                'got: ' + JSON.stringify(indexer.indexerDb.createSavepoint.firstCall && indexer.indexerDb.createSavepoint.firstCall.args));
        });

    });
});
