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
// DEPLOY unit suite: when the constructor runs, with CONSTRUCTOR_PARAMS and under
// DEPLOY_INIT_STRICT. One part of deploy.test.js; the shared fixtures are in
// helpers/deploy_suite.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { VALID_CODE_B64, baseManifest, makeVm, deployData, freshDeploySuite } = require('./helpers/deploy_suite.js');

const Deploy = require('../../../../../src/actions/deploy/index.js');

// The suite's fixtures. Every same-title block below runs freshSuite before
// each test, so each test starts from the same fixtures as the rest of the suite.
let indexer, actionsCtx, handler;
function freshSuite() {
    ({ indexer, actionsCtx, handler } = freshDeploySuite());
}

// Real readManifest always reports permissions/maxTakeBps types and, from the
// CONTRACT_META_REQUIRED flag day, the meta fields; mirror that full shape so
// neither the permissions check nor the meta verdict misfires.
function manifest(hasInitialize) {
    return baseManifest(hasInitialize);
}
function vmWithManifest(hasInitialize, executeResult) {
    return makeVm(Object.assign(
        { readManifest: sinon.stub().resolves({ success: true, manifest: manifest(hasInitialize), error: null }) },
        executeResult ? { execute: sinon.stub().resolves(executeResult) } : {}
    ));
}

describe('Deploy (DEPLOY) @regression @tier2', function () {
    beforeEach(freshSuite);
    afterEach(function () { sinon.restore(); });

    // ─── Constructor execution ────────────────────────────────────────────

    describe('constructor execution (FORMAT 0 + CONSTRUCTOR_PARAMS)', function () {

        it('runs constructor when CONSTRUCTOR_PARAMS provided and VM present', async function () {
            const vm = makeVm();
            actionsCtx.vm = vm;
            handler = new Deploy(actionsCtx);

            const data = deployData({ FORMAT: 0 });
            await handler.parse(['0', VALID_CODE_B64, '100000', 'initparam'], data, null);
            assert.ok(vm.execute.calledOnce, 'vm.execute should be called for constructor');
            assert.strictEqual(data['STATUS'], 'valid');
        });

        it('passes an explicit gasCeiling matching the top-level EXECUTE ceiling (VM-EMIT-2)', async function () {
            const vm = makeVm();
            actionsCtx.vm = vm;
            handler = new Deploy(actionsCtx);

            const data = deployData({ FORMAT: 0 });
            await handler.parse(['0', VALID_CODE_B64, '100000', 'initparam'], data, null);
            assert.ok(vm.execute.calledOnce);
            assert.strictEqual(vm.execute.firstCall.args[0].gasCeiling, 1000000,
                'constructor VM run must carry the explicit 1,000,000 root gas ceiling');
        });
    });
});

describe('Deploy (DEPLOY) @regression @tier2', function () {
    beforeEach(freshSuite);
    afterEach(function () { sinon.restore(); });

    describe('constructor execution (FORMAT 0 + CONSTRUCTOR_PARAMS)', function () {

        it('marks deploy invalid when constructor fails', async function () {
            const vm = makeVm({
                execute: sinon.stub().resolves({
                    success: false,
                    error:   'revert: bad init',
                    gasUsed: 1000,
                    stateChanges:  [],
                    stateDeletes:  [],
                    emittedActions: [],
                }),
            });
            actionsCtx.vm = vm;
            handler = new Deploy(actionsCtx);

            const data = deployData({ FORMAT: 0 });
            await handler.parse(['0', VALID_CODE_B64, '100000', 'initparam'], data, null);
            // Status is a normalised vmFailureStatus token (reverted / failed / out_of_resource)
            assert.notStrictEqual(data['STATUS'], 'valid');
        });

        it('deleteContract called when constructor fails', async function () {
            const vm = makeVm({
                execute: sinon.stub().resolves({
                    success: false, error: 'revert: bad', gasUsed: 500,
                    stateChanges: [], stateDeletes: [], emittedActions: [],
                }),
            });
            actionsCtx.vm = vm;
            handler = new Deploy(actionsCtx);

            const data = deployData({ FORMAT: 0 });
            await handler.parse(['0', VALID_CODE_B64, '100000', 'initparam'], data, null);
            assert.ok(indexer.indexerDb.deleteContract.calledOnce);
        });

    });
});

describe('Deploy (DEPLOY) @regression @tier2', function () {
    beforeEach(freshSuite);
    afterEach(function () { sinon.restore(); });

    describe('constructor execution under DEPLOY_INIT_STRICT (Option C)', function () {
        it('at/after the flag-day, runs the constructor even with NO CONSTRUCTOR_PARAMS (zero args)', async function () {
            const vm = vmWithManifest(true);
            actionsCtx.vm = vm;
            handler = new Deploy(actionsCtx);

            const data = deployData({ FORMAT: 0 });
            await handler.parse(['0', VALID_CODE_B64, '100000'], data, null);   // no CONSTRUCTOR_PARAMS field
            assert.ok(vm.execute.calledOnce, 'constructor should run when the contract exports initialize');
            assert.strictEqual(vm.execute.firstCall.args[0].method, 'initialize');
            assert.deepStrictEqual(vm.execute.firstCall.args[0].params, [], 'empty CONSTRUCTOR_PARAMS => zero args, not [""]');
            assert.strictEqual(data['STATUS'], 'valid');
        });

        it('at/after the flag-day, an arg-expecting constructor given no params fails loudly (deploy rejected)', async function () {
            const vm = vmWithManifest(true, {
                success: false, error: 'revert: missing constructor arg', gasUsed: 500,
                stateChanges: [], stateDeletes: [], emittedActions: [],
            });
            actionsCtx.vm = vm;
            handler = new Deploy(actionsCtx);

            const data = deployData({ FORMAT: 0 });
            await handler.parse(['0', VALID_CODE_B64, '100000'], data, null);
            assert.ok(vm.execute.calledOnce);
            assert.notStrictEqual(data['STATUS'], 'valid');    // no longer a silent uninitialised 'valid'
            assert.ok(indexer.indexerDb.deleteContract.calledOnce);
        });

        it('BELOW the flag-day, the same params-less deploy is byte-identical: constructor NOT run, commits valid', async function () {
            const isEnabled = sinon.stub().resolves(true);
            isEnabled.withArgs('DEPLOY_INIT_STRICT', sinon.match.any).resolves(false);
            actionsCtx.protocolChanges.isEnabled = isEnabled;
            const vm = vmWithManifest(true);
            actionsCtx.vm = vm;
            handler = new Deploy(actionsCtx);

            const data = deployData({ FORMAT: 0 });
            await handler.parse(['0', VALID_CODE_B64, '100000'], data, null);
            assert.ok(vm.execute.notCalled, 'below the flag-day a params-less deploy runs no constructor (legacy)');
            assert.strictEqual(data['STATUS'], 'valid');
        });

        it('at/after the flag-day, a contract with NO initialize export runs no constructor and commits valid', async function () {
            const vm = vmWithManifest(false);
            actionsCtx.vm = vm;
            handler = new Deploy(actionsCtx);

            const data = deployData({ FORMAT: 0 });
            await handler.parse(['0', VALID_CODE_B64, '100000'], data, null);
            assert.ok(vm.execute.notCalled, 'no constructor to run');
            assert.strictEqual(data['STATUS'], 'valid');
        });
    });
});

describe('Deploy (DEPLOY) @regression @tier2', function () {
    beforeEach(freshSuite);
    afterEach(function () { sinon.restore(); });

    describe('constructor execution under DEPLOY_INIT_STRICT (Option C)', function () {
        it('with CONSTRUCTOR_PARAMS present, still runs the constructor with those args (unchanged path)', async function () {
            const vm = vmWithManifest(true);
            actionsCtx.vm = vm;
            handler = new Deploy(actionsCtx);

            const data = deployData({ FORMAT: 0 });
            await handler.parse(['0', VALID_CODE_B64, '100000', 'a', 'b'], data, null);
            assert.ok(vm.execute.calledOnce);
            assert.deepStrictEqual(vm.execute.firstCall.args[0].params, ['a', 'b']);
            assert.strictEqual(data['STATUS'], 'valid');
        });
    });
});
