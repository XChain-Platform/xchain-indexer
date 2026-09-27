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
 * test/unit/actions/stake/vote_invariants.test/callback_probe_listing.test.js
 *
 * The method-independent callback listing and its legacy fallback.
 */

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const XChainVM = require('xchain-vm');

const { freshVote } = require('./helpers/vote_fixtures.js');
const { MAX_CODE_SIZE } = require('../../../../../src/protocol/constants.js');
const bindingCallback = require('../../../../../src/actions/vote/binding_callback.js');
const callbackProbeVm = require('../../../../../src/actions/vote/callback_probe_vm.js');

function codeAtSize(size){
    const source = 'module.exports={onResult:function(){}};';
    return source + ' '.repeat(size - Buffer.byteLength(source, 'utf8'));
}

function realProbeOptions(indexer){
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

function probeContext(contractIndex = 5){
    return {
        network: 'regtest',
        contractAddress: 'C:BTC:' + contractIndex,
        blockContext: { height: 100, timestamp: 1700000000 }
    };
}

async function handlerVerdict(fresh, code, method){
    fresh.indexer.indexerDb.getContract = sinon.stub().resolves({ action_index: 5, code, status_id: 1 });
    fresh.indexer.indexerDb.getStatusString = sinon.stub().resolves('valid');
    const data = {
        CALLBACK_CONTRACT: '5', CALLBACK_METHOD: method, CALLBACK_ON: 'pass',
        BLOCK_INDEX: 100, BLOCK_TIME: 1700000000
    };
    const error = await bindingCallback.validateCallbackTarget.call(fresh.handler, data, null);
    return error === null;
}

async function legacyVerdict(realProbe, code, method){
    const result = await realProbe.readManifest(
        callbackProbeVm.buildProbeCode(code, method), probeContext()
    );
    return !!(result && result.success && result.manifest && result.manifest.hasInitialize === true);
}

describe('VOTE callback method-independent listing probe', function(){
    afterEach(function(){ sinon.restore(); });

    it('builds fixed bytes without callback method text', function(){
        const code = 'module.exports={};';
        const first = callbackProbeVm.buildListingProbeCode(code, 'uniqueFirstMethod');
        const second = callbackProbeVm.buildListingProbeCode(code, 'uniqueSecondMethod');
        assert.strictEqual(first, second);
        assert.ok(!first.includes('uniqueFirstMethod'));
        assert.ok(!first.includes('uniqueSecondMethod'));
    });

    it('returns null for every unusable listing shape', function(){
        const unusable = [
            { metaOversize: true, metaError: false, metaJson: null },
            { metaOversize: false, metaError: true, metaJson: null },
            { metaOversize: false, metaError: false, metaJson: '{bad json' },
            { metaOversize: false, metaError: false, metaJson: '{"callbackFns":["ok",3]}' }
        ];
        for(const manifest of unusable)
            assert.strictEqual(callbackProbeVm.listingVerdict(manifest, 'ok'), null);
    });

    it('falls back to the per-method probe for every unusable listing', async function(){
        const unusable = [
            { metaOversize: true, metaError: false, metaJson: null },
            { metaOversize: false, metaError: true, metaJson: null },
            { metaOversize: false, metaError: false, metaJson: '{bad json' },
            { metaOversize: false, metaError: false, metaJson: '{"callbackFns":{}}' }
        ];
        const buildFallback = sinon.spy(callbackProbeVm, 'buildProbeCode');
        for(const manifest of unusable){
            const fresh = freshVote();
            fresh.actionsCtx.getVoteCallbackProbeVm().limits = {
                maxCodeSize: MAX_CODE_SIZE + callbackProbeVm.PROBE_SUFFIX_ALLOWANCE
            };
            fresh.vm.probeReadManifest.onFirstCall().resolves({ success: true, manifest, error: null });
            fresh.vm.probeReadManifest.onSecondCall().resolves({
                success: true, manifest: { hasInitialize: true }, error: null
            });
            assert.strictEqual(await handlerVerdict(fresh, 'module.exports={onResult:function(){}};', 'onResult'), true);
            assert.strictEqual(fresh.vm.probeReadManifest.callCount, 2);
        }
        assert.strictEqual(buildFallback.callCount, unusable.length);
    });

    it('uses the listing without a legacy probe regardless of reported limits', async function(){
        const reportedLimits = [undefined, { maxCodeSize: MAX_CODE_SIZE }];
        const buildFallback = sinon.spy(callbackProbeVm, 'buildProbeCode');
        for(const limits of reportedLimits){
            const fresh = freshVote();
            fresh.actionsCtx.getVoteCallbackProbeVm().limits = limits;
            fresh.vm.probeReadManifest.resolves({
                success: true,
                manifest: { metaJson: '{"callbackFns":["onResult"]}' },
                error: null
            });
            const code = 'module.exports={onResult:function(){}};';
            assert.strictEqual(await handlerVerdict(fresh, code, 'onResult'), true);
            assert.strictEqual(fresh.vm.probeReadManifest.callCount, 1);
            assert.strictEqual(fresh.vm.probeReadManifest.firstCall.args[0],
                callbackProbeVm.buildListingProbeCode(code));
        }
        assert.strictEqual(buildFallback.callCount, 0);
    });

    it('falls back exactly once when the listing probe throws', async function(){
        const fresh = freshVote();
        const buildFallback = sinon.spy(callbackProbeVm, 'buildProbeCode');
        fresh.vm.probeReadManifest.onFirstCall().rejects(new Error('listing failed'));
        fresh.vm.probeReadManifest.onSecondCall().resolves({
            success: true, manifest: { hasInitialize: true }, error: null
        });
        assert.strictEqual(await handlerVerdict(
            fresh, 'module.exports={onResult:function(){}};', 'onResult'
        ), true);
        assert.strictEqual(fresh.vm.probeReadManifest.callCount, 2);
        assert.strictEqual(buildFallback.callCount, 1);
    });

});

describe('real XChainVM callback listing equivalence', function(){
    let fresh, realProbe;

    before(function(){
        fresh = freshVote();
        realProbe = new XChainVM(realProbeOptions(fresh.indexer));
        fresh.actionsCtx.getVoteCallbackProbeVm = sinon.stub().returns(realProbe);
    });

    after(async function(){
        sinon.restore();
        if(realProbe) await realProbe.shutdown();
    });

    it('matches the legacy verdict for each export and method shape', async function(){
        const contracts = [
            'module.exports={onResult:function(){}};',
            'module.exports=function(){};',
            'module.exports=null;',
            'module.exports={onResult:function(){},get bad(){throw new Error("bad")}};',
            'module.exports={onResult:7};',
            'class Callback{onResult(){}};module.exports=new Callback();'
        ];
        const methods = ['onResult', 'missing', 'toString', 'bad'];
        for(const code of contracts){
            for(const method of methods){
                const expected = await legacyVerdict(realProbe, code, method);
                const actual = await handlerVerdict(fresh, code, method);
                assert.strictEqual(actual, expected, code + ' method ' + method);
            }
        }
    });

    it('admits the fixed suffix after a MAX_CODE_SIZE contract', async function(){
        const probeCode = callbackProbeVm.buildListingProbeCode(codeAtSize(MAX_CODE_SIZE));
        assert.ok(Buffer.byteLength(probeCode, 'utf8') <=
            MAX_CODE_SIZE + callbackProbeVm.PROBE_SUFFIX_ALLOWANCE);
        const result = await realProbe.readManifest(probeCode, probeContext());
        assert.strictEqual(result.success, true);
        assert.strictEqual(callbackProbeVm.listingVerdict(result.manifest, 'onResult'), true);
    });
});
