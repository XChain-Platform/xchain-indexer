// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const assert = require('assert');
const crypto = require('crypto');

const ProtocolChanges = require('../../../../src/protocol_changes.js');
const { runControllerGuard } = require('../../../../src/actions/execute/controller_guard.js');
const Attest = require('../../../../src/actions/attest/index.js');
const Xcall = require('../../../../src/actions/xcall/index.js');

const GATE_KEY =
    'guard_emitted_host_discriminator_activation.GUARD_EMITTED_HOST_DISCRIMINATOR_ACTIVATION';

function makeGuardHandler(){
    const vmOptions = [];
    const emissionContexts = [];
    const indexerDb = {
        getContract: async () => ({ code: 'module.exports = {}' }),
        getStatusString: async () => 'valid',
        getContractState: async () => ({}),
        getOracleDataForVM: async () => ({}),
        getCrossChainDataForVM: async () => ({}),
        getPollResultsForVM: async () => ({}),
        getContractStakeDataForVM: async () => ({}),
        createSavepoint: async (name) => name,
        releaseSavepoint: async () => {},
        rollbackToSavepoint: async () => {},
        countContractEmissionsForExecution: async () => 0,
        createContractExecution: async () => {},
        createContractEmission: async () => {},
    };
    const handler = {
        config: {
            NETWORK: 'regtest', COIN: 'BTC', CHAIN: 'BTC',
            CONTROLLER_MAX_TAKE_BPS: 10000,
        },
        indexerDb,
        actions: {
            protocolChanges: { isEnabled: async () => false },
            vm: {
                execute: async (opts) => {
                    vmOptions.push(opts);
                    return {
                        success: true, gasUsed: 1, returnValue: null,
                        stateChanges: [], stateDeletes: [],
                        emittedActions: [{ action: 'EXECUTE', params: {} }],
                    };
                },
            },
        },
        util: {
            isNull: (value) => value === null || value === undefined,
            resolveGuardGasCeiling: () => 1000,
            vmFailureStatus: () => 'failed',
        },
        processEmission: async (emission, context, position) => {
            emissionContexts.push({ emission, context, position });
        },
        guardSavepointCounter: 0,
    };
    return { handler, vmOptions, emissionContexts };
}

function guardOpts(blockIndex, callPath, actionIndex, isEmission = true){
    return {
        actionType: 'SEND', controllerIndex: 9, tick: 'CTRL', from: 'A', to: 'B',
        amount: '1', seq: 0, callDepth: 1,
        hostData: {
            ACTION_INDEX: actionIndex, BLOCK_INDEX: blockIndex, BLOCK_TIME: 1700000000,
            SOURCE: 'C:BTC:7', TX_HASH: 'ab'.repeat(32), TX_INDEX: 3, TX_VOUT: 4,
            ROOT_ACTION_INDEX: '4.2', CALL_PATH: callPath, IS_EMISSION: isEmission,
        },
    };
}

function hashPreimage(values){
    return crypto.createHash('sha256').update(values.join(':')).digest('hex');
}

function descendantEmissionData(vmOpts){
    return {
        TX_HASH: vmOpts.txHash,
        ROOT_ACTION_INDEX: vmOpts.rootActionIndex,
        EMITTER_PATH: vmOpts.callPath === '' ? '0' : vmOpts.callPath + '>0',
        CONTRACT_INDEX: 91,
        EMITTER_POSITION: 0,
        TARGET_CHAIN: 'DOGE',
    };
}

function productionDerivations(vmOptions){
    const attest = Object.create(Attest.prototype);
    const xcall = Object.create(Xcall.prototype);
    xcall.config = { NETWORK: 'regtest', COIN: 'BTC' };
    return vmOptions.map((opts) => {
        const data = descendantEmissionData(opts);
        const requestId = hashPreimage(attest.requestIdPreimageValues(data));
        const callId = hashPreimage(xcall.callIdPreimageValues(data));
        assert.strictEqual(attest.requestIdDerivationError({ ...data, REQUEST_ID: requestId }), null);
        assert.strictEqual(xcall.deriveCallId({ ...data, CALL_ID: callId }, null), null);
        return { data, requestId, callId };
    });
}

async function runGuard(fixture, opts){
    return runControllerGuard.call(fixture.handler, opts, { MAX_CALL_DEPTH: 8 });
}

async function runSiblingGuards(blockIndex){
    const fixture = makeGuardHandler();
    await runGuard(fixture, guardOpts(blockIndex, '0', 100));
    await runGuard(fixture, guardOpts(blockIndex, '1', 101));
    return fixture;
}

describe('controller guard emitted-host discriminator @regression @tier1', function () {
    it('uses an unarmed public-ledger rule and a regtest genesis boundary', function () {
        assert.deepStrictEqual(ProtocolChanges.get(GATE_KEY), {
            mainnet: ProtocolChanges.UNARMED,
            testnet: ProtocolChanges.UNARMED,
            regtest: 0,
        });
    });

    it('reproduces the guarded emitted-host collision below the activation', async function () {
        const { vmOptions, emissionContexts } = await runSiblingGuards(-1);
        const derived = productionDerivations(vmOptions);
        assert.strictEqual(derived[0].requestId, derived[1].requestId);
        assert.strictEqual(derived[0].callId, derived[1].callId);
        assert.deepStrictEqual(vmOptions.map((opts) => opts.callPath), ['', '']);
        assert.deepStrictEqual(vmOptions.map((opts) => opts.rootActionIndex), [4, 4]);
        assert.deepStrictEqual(emissionContexts.map((entry) => entry.context.CALL_PATH), ['', '']);
    });

    it('separates guarded emitted hosts and byte-matches VM and host routing at activation', async function () {
        const { vmOptions, emissionContexts } = await runSiblingGuards(0);
        const derived = productionDerivations(vmOptions);
        assert.notStrictEqual(derived[0].requestId, derived[1].requestId);
        assert.notStrictEqual(derived[0].callId, derived[1].callId);
        assert.deepStrictEqual(vmOptions.map((opts) => opts.callPath), ['0', '1']);
        assert.deepStrictEqual(vmOptions.map((opts) => opts.rootActionIndex), ['4.2', '4.2']);
        assert.deepStrictEqual(emissionContexts.map((entry) => entry.context.CALL_PATH), ['0', '1']);
        assert.deepStrictEqual(emissionContexts.map((entry) => entry.context.ROOT_ACTION_INDEX), ['4.2', '4.2']);
        for(let i = 0; i < vmOptions.length; i++){
            assert.strictEqual(emissionContexts[i].context.CALL_PATH, vmOptions[i].callPath);
            assert.strictEqual(emissionContexts[i].context.ROOT_ACTION_INDEX, vmOptions[i].rootActionIndex);
        }
    });

    it('keeps a native guarded host on the legacy discriminator at activation', async function () {
        const fixture = makeGuardHandler();
        await runGuard(fixture, guardOpts(0, '9', 100, false));
        assert.strictEqual(fixture.vmOptions[0].callPath, '');
        assert.strictEqual(fixture.vmOptions[0].rootActionIndex, 4);
        assert.strictEqual(fixture.emissionContexts[0].context.CALL_PATH, '');
        assert.strictEqual(fixture.emissionContexts[0].context.ROOT_ACTION_INDEX, 4);
    });

    it('rejects an active emitted host without a deterministic call path', async function () {
        const fixture = makeGuardHandler();
        await assert.rejects(
            () => runGuard(fixture, guardOpts(0, '', 100)),
            /controller guard emitted host missing CALL_PATH/
        );
        assert.strictEqual(fixture.vmOptions.length, 0);
        assert.strictEqual(fixture.emissionContexts.length, 0);
    });
});
