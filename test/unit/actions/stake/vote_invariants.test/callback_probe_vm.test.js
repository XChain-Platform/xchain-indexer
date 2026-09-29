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
 * test/unit/actions/stake/vote_invariants.test/callback_probe_vm.test.js
 *
 * The long-lived manifest probe used to admit VOTE callback bindings.
 */

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createBaseData } = require('../../../../fixtures/mocks');
const { freshVote } = require('./helpers/vote_fixtures.js');
const { resolveXChainVM } = require('./helpers/xchain_vm_optional.js');
const { MAX_CODE_SIZE } = require('../../../../../src/protocol/constants.js');
const callbackProbeVm = require('../../../../../src/actions/vote/callback_probe_vm.js');
const { XChainVM, available: xchainVmAvailable } = resolveXChainVM();

let indexer, actionsCtx, handler, vm;

function freshHandler(){
    ({ indexer, actionsCtx, handler, vm } = freshVote());
}

function bindingCreateParams(){
    return ['0', 'TEST', '200', 'yes,no', '', '', '', '0.1', '1', '', '', '', '',
            '5', 'onResult', '', 'pass', ''];
}

function codeAtSize(size){
    const source = 'module.exports={onResult:function(){}};';
    return source + ' '.repeat(size - Buffer.byteLength(source, 'utf8'));
}

function stubBindingCreate(contract, status = 'valid'){
    indexer.indexerDb.getTokenInfo.resolves({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0, SUPPLY: '1000' });
    indexer.indexerDb.createTicker.resolves(1);
    indexer.indexerDb.getAddressBalances.resolves({ 1: '100' });
    indexer.indexerDb.getContract = sinon.stub().resolves(contract);
    indexer.indexerDb.getStatusString = sinon.stub().resolves(status);
    indexer.indexerDb.createPoll = sinon.stub().resolves();
}

async function runBindingCreate(overrides = {}, params = bindingCreateParams()){
    const data = createBaseData({ ACTION: 'VOTE', FORMAT: 0, BLOCK_INDEX: 100, ACTION_INDEX: 50, SOURCE: 'creatorAddr', ...overrides });
    await handler.parse(params, data, null);
    return data;
}

// The same create with CALLBACK_CONTRACT and CALLBACK_METHOD blank: a signaling poll.
function signalingCreateParams(){
    const params = bindingCreateParams();
    params[13] = '';
    params[14] = '';
    return params;
}

function realProbeOptions(){
    return {
        execution: 'subprocess',
        gasSchedule: indexer.config['GAS_SCHEDULE'],
        gasCeiling: 1000000,
        limits: {
            maxCpuTimeMs: 30000,
            maxMemory: 8,
            maxEmissions: 50,
            maxStateKeys: 10000,
            maxStateValueSize: 65536,
            maxCodeSize: MAX_CODE_SIZE + callbackProbeVm.PROBE_SUFFIX_ALLOWANCE
        }
    };
}

describe('Vote invariants (escrow conservation + callback metering) @regression @tier1', function(){
    beforeEach(freshHandler);
    afterEach(function(){ sinon.restore(); });

    describe('VOTE callback manifest probe admission', function(){
        it('refuses inactive and missing-method targets', async function(){
            stubBindingCreate({ action_index: 5, code: codeAtSize(100), status_id: 2 }, 'invalid: disabled');
            let inactive = await runBindingCreate();
            assert.strictEqual(inactive.STATUS, 'invalid: CALLBACK_CONTRACT (not active)');
            assert.strictEqual(vm.probeInstances.length, 0, 'inactive contracts are refused before probing');

            freshHandler();
            const code = 'module.exports={other:function(){}}';
            stubBindingCreate({ action_index: 5, code, status_id: 1 });
            vm.probeReadManifest.resolves({
                success: true, manifest: { metaJson: '{"callbackFns":["other"]}' }, error: null
            });
            let missing = await runBindingCreate();
            assert.strictEqual(missing.STATUS, 'invalid: CALLBACK_METHOD (unavailable)');
            assert.ok(vm.probeReadManifest.calledOnce);
            assert.strictEqual(vm.probeReadManifest.firstCall.args[0],
                callbackProbeVm.buildListingProbeCode(code));
            assert.ok(indexer.indexerDb.createPoll.notCalled);
        });

        it('refuses stored code over the cap without constructing the probe', async function(){
            stubBindingCreate({ action_index: 5, code: codeAtSize(MAX_CODE_SIZE + 1), status_id: 1 });
            const data = await runBindingCreate();
            assert.strictEqual(data.STATUS, 'invalid: CALLBACK_METHOD (unavailable)');
            assert.strictEqual(vm.probeInstances.length, 0);
            assert.ok(vm.probeReadManifest.notCalled);
        });

        it('accepts cap-minus-one and cap contracts with one reused probe VM', async function(){
            vm.probeReadManifest.resolves({
                success: true, manifest: { metaJson: '{"callbackFns":["onResult"]}' }, error: null
            });
            stubBindingCreate({ action_index: 5, code: codeAtSize(MAX_CODE_SIZE - 1), status_id: 1 });
            let belowCap = await runBindingCreate();
            assert.strictEqual(belowCap.STATUS, 'valid');

            stubBindingCreate({ action_index: 5, code: codeAtSize(MAX_CODE_SIZE), status_id: 1 });
            let atCap = await runBindingCreate();
            assert.strictEqual(atCap.STATUS, 'valid');
            assert.strictEqual(vm.probeInstances.length, 1, 'both VOTEs share one probe construction');
            assert.strictEqual(vm.probeReadManifest.callCount, 2);
            assert.strictEqual(vm.probeInstances[0].config.limits.maxCodeSize,
                MAX_CODE_SIZE + callbackProbeVm.PROBE_SUFFIX_ALLOWANCE);
            assert.strictEqual(vm.probeInstances[0].config.limits.maxMemory, vm.limits.maxMemory);
            assert.deepStrictEqual(vm.probeReadManifest.firstCall.args[1], {
                network: 'regtest',
                contractAddress: 'C:BTC:5',
                blockContext: { height: 100, timestamp: 1700000000 }
            });
            assert.ok(vm.probeInstances[0].shutdown.notCalled, 'the warm probe stays alive between VOTEs');
        });

        it('reuses the probe VM after its worker restarts from a throw', async function(){
            stubBindingCreate({ action_index: 5, code: codeAtSize(100), status_id: 1 });
            vm.probeReadManifest.onFirstCall().rejects(new Error('probe worker failed'));
            vm.probeReadManifest.onSecondCall().resolves({ success: true, manifest: { hasInitialize: true }, error: null });
            vm.probeReadManifest.onThirdCall().resolves({
                success: true, manifest: { metaJson: '{"callbackFns":["onResult"]}' }, error: null
            });
            const recovered = await runBindingCreate();
            assert.strictEqual(recovered.STATUS, 'valid');
            const probeVm = vm.probeInstances[0];
            assert.ok(probeVm.shutdown.notCalled);

            const retried = await runBindingCreate();
            assert.strictEqual(retried.STATUS, 'valid');
            assert.strictEqual(vm.probeReadManifest.callCount, 3);
            assert.strictEqual(vm.probeInstances.length, 1, 'the executor restarts its worker inside the same VM');
            assert.strictEqual(actionsCtx.getVoteCallbackProbeVm.secondCall.returnValue, probeVm);
        });

        it('preserves below-gate admission without status reads or a probe', async function(){
            actionsCtx.config.NETWORK = 'mainnet';
            stubBindingCreate({ action_index: 5, code: 'module.exports={other:function(){}}', status_id: 2 }, 'invalid: disabled');
            const data = await runBindingCreate();
            assert.strictEqual(data.STATUS, 'valid');
            assert.ok(indexer.indexerDb.getStatusString.notCalled);
            assert.strictEqual(vm.probeInstances.length, 0);
        });
    });

    describe('VOTE callback probe on the public guard-inert dry-run', function(){
        it('refuses the method probe as unjudged and never builds the probe VM', async function(){
            stubBindingCreate({ action_index: 5, code: codeAtSize(100), status_id: 1 });
            const data = await runBindingCreate({ GUARD_INERT: true });
            assert.ok(String(data.STATUS).startsWith('invalid: '), data.STATUS);
            assert.ok(indexer.util.isGuardInertError(data.STATUS), data.STATUS);
            assert.ok(String(data.STATUS).includes('contract 5'), data.STATUS);
            assert.strictEqual(vm.probeInstances.length, 0);
            assert.ok(vm.probeReadManifest.notCalled);
            assert.ok(actionsCtx.getVoteCallbackProbeVm.notCalled);
            assert.ok(indexer.indexerDb.createPoll.notCalled);
        });

        it('keeps the real verdict for an inactive callback contract', async function(){
            stubBindingCreate({ action_index: 5, code: codeAtSize(100), status_id: 2 }, 'invalid: disabled');
            const data = await runBindingCreate({ GUARD_INERT: true });
            assert.strictEqual(data.STATUS, 'invalid: CALLBACK_CONTRACT (not active)');
            assert.strictEqual(vm.probeInstances.length, 0);
        });

        it('leaves a signaling poll create fully judged', async function(){
            stubBindingCreate({ action_index: 5, code: codeAtSize(100), status_id: 1 });
            const data = await runBindingCreate({ GUARD_INERT: true }, signalingCreateParams());
            assert.strictEqual(data.STATUS, 'valid');
            assert.strictEqual(vm.probeInstances.length, 0);
        });

        it('still probes a block transaction, where GUARD_INERT is false', async function(){
            stubBindingCreate({ action_index: 5, code: codeAtSize(100), status_id: 1 });
            vm.probeReadManifest.resolves({
                success: true, manifest: { metaJson: '{"callbackFns":["onResult"]}' }, error: null
            });
            const data = await runBindingCreate({ GUARD_INERT: false });
            assert.strictEqual(data.STATUS, 'valid');
            assert.ok(vm.probeReadManifest.calledOnce);
        });
    });
});

describe('Vote invariants (escrow conservation + callback metering) @regression @tier1', function(){
    beforeEach(freshHandler);
    afterEach(function(){ sinon.restore(); });

    describe('real XChainVM callback probe boundary', function(){
        before(function(){ if(!xchainVmAvailable) this.skip(); });

        it('accepts a callable contract at MAX_CODE_SIZE', async function(){
            this.timeout(30000);
            const realProbe = new XChainVM(realProbeOptions());
            actionsCtx.getVoteCallbackProbeVm = sinon.stub().returns(realProbe);
            actionsCtx.discardVoteCallbackProbeVm = sinon.stub().callsFake(async () => realProbe.shutdown());
            stubBindingCreate({ action_index: 5, code: codeAtSize(MAX_CODE_SIZE), status_id: 1 });
            try {
                const data = await runBindingCreate();
                assert.strictEqual(data.STATUS, 'valid');
                assert.ok(indexer.indexerDb.createPoll.calledOnce);
            } finally {
                await realProbe.shutdown();
            }
        });
    });
});
