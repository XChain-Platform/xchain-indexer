// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const assert = require('assert');
const sinon = require('sinon');
const Utility = require('../../src/utility.js');
const gateRegistry = require('../../src/consensus/gate_registry.js');
const { getCoinConfig } = require('../../src/coins/index.js');
const { maxPriceAgeSecondsAt } = require('../../src/utility/price_age/oracle_price_age.js');
const feePricing = require('../../src/actions/actions_class/fee_pricing.js');
const feeViews = require('../../src/actions/actions_class/fee_views.js');
const attestSettle = require('../../src/actions/attest/settle.js');
const constructorRun = require('../../src/actions/deploy/constructor_run.js');
const controllerGuard = require('../../src/actions/execute/controller_guard.js');
const runVm = require('../../src/actions/execute/run_vm.js');

const GATE = 'oracle_price_age_hourly_activation.ORACLE_PRICE_AGE_HOURLY_ACTIVATION';
const NETWORK = 'testnet';
const CHAINS = ['BTC', 'LTC', 'DOGE'];
const FEE_DESTINATION = 'feeDestinationAddr111111111111111';
const ACTIVATION = 700_000;
const BLOCK_TIME = 10_000;
const SNAPSHOT_TIME = BLOCK_TIME - 3_000;

function hourlyConfig(extra){
    return Object.assign({
        CHAIN: 'BTC',
        COIN: 'BTC',
        NETWORK: NETWORK,
        ORACLE_MAX_PRICE_AGE_SECONDS: 1800,
        ORACLE_MAX_PRICE_AGE_HOURLY_SECONDS: 4500
    }, extra || {});
}

function activationFor(chainKey){
    return gateRegistry.get(GATE)[chainKey + ':' + NETWORK];
}

function armHourlyGate(){
    return sinon.stub(gateRegistry, 'activeAt').callsFake((gate, network, chainKey, blockIndex) => {
        return gate === GATE && network === NETWORK && chainKey === 'BTC' && blockIndex >= ACTIVATION;
    });
}

function feeOracleResult(maxPriceAgeSeconds){
    if(BLOCK_TIME - SNAPSHOT_TIME > maxPriceAgeSeconds)
        return { error: 'stale beyond ' + maxPriceAgeSeconds + 's' };
    return {
        xchainUsdPrice: '1.00000000',
        coinUsdPrice: '0.10000000',
        oracleRound: 7
    };
}

function oracleDataResult(maxPriceAgeSeconds){
    return BLOCK_TIME - SNAPSHOT_TIME <= maxPriceAgeSeconds ? { BTC: 'fresh' } : null;
}

function registerPriceAgeBasics(){
    afterEach(function(){
        sinon.restore();
    });

    it('selects 1800 below and the pinned 4500 at the gate for every chain key', function(){
        let gates = gateRegistry.get(GATE);
        for(let chainKey of CHAINS){
            let config = getCoinConfig(chainKey, NETWORK);
            let activation = gates[chainKey + ':' + NETWORK];
            assert.strictEqual(
                maxPriceAgeSecondsAt(config, NETWORK, chainKey, activation - 1), 1800, chainKey);
            assert.strictEqual(
                maxPriceAgeSecondsAt(config, NETWORK, chainKey, activation), 4500, chainKey);
        }
    });

    it('keeps the 1800 fallback for a missing selected config value', function(){
        let activation = activationFor('BTC');
        assert.strictEqual(maxPriceAgeSecondsAt({}, NETWORK, 'BTC', activation), 1800);
    });

    it('refuses a native fee with a 3000 second old snapshot below the gate and accepts it at the gate', async function(){
        let activeAt = armHourlyGate();
        let config = {
            COIN: 'BTC',
            NETWORK: NETWORK,
            ADDRESS: { FEE_DESTINATION: FEE_DESTINATION },
            FEE_TOLERANCE_MIN: '0.95',
            FEE_TOLERANCE_MAX: '1.10',
            ORACLE_MAX_PRICE_AGE_SECONDS: 1800,
            ORACLE_MAX_PRICE_AGE_HOURLY_SECONDS: 4500
        };
        let util = new Utility(config);
        let db = {
            getLatestPrice: async (pair, blockIndex, opts) => {
                if(opts.blockTime - SNAPSHOT_TIME > opts.maxAgeSeconds) return null;
                let price = pair === 'BTC/USD' ? '0.10000000' : '1.00000000';
                return { price: price, roundNumber: 7, block_timestamp: SNAPSHOT_TIME };
            }
        };
        let feeOutput = [{ address: FEE_DESTINATION, value: '10.00000000' }];
        let data = { BLOCK_INDEX: ACTIVATION - 1, BLOCK_TIME: BLOCK_TIME, COIN: 'BTC' };

        let below = await util.validateNativeCoinFee(data, { AMOUNT: '1.0' }, db, feeOutput);
        assert.strictEqual(below.valid, false);
        assert.match(below.error, /stale beyond 1800s/);

        data.BLOCK_INDEX = ACTIVATION;
        let at = await util.validateNativeCoinFee(data, { AMOUNT: '1.0' }, db, feeOutput);
        assert.strictEqual(at.valid, true, at.error);
        assert.strictEqual(at.oracleRound, 7);
        assert.deepStrictEqual(activeAt.firstCall.args, [GATE, NETWORK, 'BTC', ACTIVATION - 1, null]);
        assert.deepStrictEqual(activeAt.secondCall.args, [GATE, NETWORK, 'BTC', ACTIVATION, null]);
    });
}

function registerFeePricing(){
    it('flips fee pricing from stale to valid at the quoted block gate', async function(){
        armHourlyGate();
        let config = hourlyConfig({ FEE_TOLERANCE_MIN: '0.95', FEE_TOLERANCE_MAX: '1.10' });
        let util = new Utility(config);
        let priceRead = sinon.stub(util, 'getFeeOraclePrices').callsFake(
            (db, coin, blockIndex, blockTime, maxPriceAgeSeconds) => feeOracleResult(maxPriceAgeSeconds));
        let indexerDb = {};
        let context = {
            config: config,
            indexerDb: indexerDb,
            util: util
        };

        let below = await feePricing.priceFeeQuote.call(
            context, { blockIndex: ACTIVATION - 1, blockTime: BLOCK_TIME }, '1', null);
        let at = await feePricing.priceFeeQuote.call(
            context, { blockIndex: ACTIVATION, blockTime: BLOCK_TIME }, '1', null);

        assert.strictEqual(below.valid, false);
        assert.strictEqual(below.error, 'stale beyond 1800s');
        assert.strictEqual(at.valid, true, at.error);
        assert.strictEqual(at.oracleRound, 7);
        assert.deepStrictEqual(priceRead.firstCall.args,
            [indexerDb, 'BTC', ACTIVATION - 1, BLOCK_TIME, 1800]);
        assert.deepStrictEqual(priceRead.secondCall.args,
            [indexerDb, 'BTC', ACTIVATION, BLOCK_TIME, 4500]);
    });
}

function registerFeeSchedule(){
    it('flips the fee schedule price verdict at the tip block gate', async function(){
        armHourlyGate();
        let blockIndex = ACTIVATION - 1;
        let config = hourlyConfig();
        let util = new Utility(config);
        let priceRead = sinon.stub(util, 'getFeeOraclePrices').callsFake(
            (db, coin, readBlockIndex, blockTime, maxPriceAgeSeconds) => feeOracleResult(maxPriceAgeSeconds));
        let indexerDb = {
            getLatestBlockIndex: async () => blockIndex,
            getBlockTime: async () => BLOCK_TIME
        };
        let context = {
            config: config,
            indexerDb: indexerDb,
            util: util
        };

        let below = await feeViews.getFeeSchedule.call(context);
        blockIndex = ACTIVATION;
        let at = await feeViews.getFeeSchedule.call(context);

        assert.strictEqual(below.prices.available, false);
        assert.strictEqual(below.prices.error, 'stale beyond 1800s');
        assert.strictEqual(at.prices.available, true);
        assert.strictEqual(at.prices.oracleRound, 7);
        assert.deepStrictEqual(priceRead.firstCall.args,
            [indexerDb, 'BTC', ACTIVATION - 1, BLOCK_TIME, 1800]);
        assert.deepStrictEqual(priceRead.secondCall.args,
            [indexerDb, 'BTC', ACTIVATION, BLOCK_TIME, 4500]);
    });
}

function registerAttestationPricing(){
    it('flips attestation settlement pricing at its action block gate', async function(){
        armHourlyGate();
        let priceRead = sinon.stub().callsFake(
            (db, coin, blockIndex, blockTime, maxPriceAgeSeconds) => feeOracleResult(maxPriceAgeSeconds));
        let indexerDb = {};
        let context = {
            config: hourlyConfig(),
            indexerDb: indexerDb,
            util: { getFeeOraclePrices: priceRead }
        };

        let below = await attestSettle.broadcastFeePrices.call(
            context, {}, { BLOCK_INDEX: ACTIVATION - 1, BLOCK_TIME: BLOCK_TIME });
        let at = await attestSettle.broadcastFeePrices.call(
            context, {}, { BLOCK_INDEX: ACTIVATION, BLOCK_TIME: BLOCK_TIME });

        assert.strictEqual(below, null);
        assert.strictEqual(at.oracleRound, 7);
        assert.deepStrictEqual(priceRead.firstCall.args,
            [indexerDb, 'BTC', ACTIVATION - 1, BLOCK_TIME, 1800]);
        assert.deepStrictEqual(priceRead.secondCall.args,
            [indexerDb, 'BTC', ACTIVATION, BLOCK_TIME, 4500]);
    });
}

function registerConstructorExecution(){
    it('flips deployment constructor execution at its action block gate', async function(){
        armHourlyGate();
        let oracleRead = sinon.stub().callsFake(
            (blockIndex, blockTime, maxPriceAgeSeconds) => oracleDataResult(maxPriceAgeSeconds));
        let deploy = {
            config: hourlyConfig(),
            providerDeadlineWindows: {},
            actions: {
                protocolChanges: { isEnabled: async () => false },
                vm: {
                    execute: async options => {
                        let fresh = options.oracleData !== null;
                        return { success: fresh, error: fresh ? null : 'stale oracle', gasUsed: 1 };
                    }
                }
            },
            indexerDb: {
                getOracleDataForVM: oracleRead,
                getCrossChainDataForVM: async () => ({}),
                getPollResultsForVM: async () => ({})
            }
        };
        function buildRun(blockIndex){
            return {
                data: {
                    BLOCK_INDEX: blockIndex,
                    BLOCK_TIME: BLOCK_TIME,
                    SOURCE: 'source',
                    ACTION_INDEX: 11,
                    TX_HASH: 'tx'
                },
                runConstructor: true,
                rootDiscrim: 0,
                code: 'code',
                contractAddress: 'C:BTC:11',
                constructorParams: '',
                totalGas: 1
            };
        }

        let below = buildRun(ACTIVATION - 1);
        let at = buildRun(ACTIVATION);
        await constructorRun.executeConstructor(deploy, below);
        await constructorRun.executeConstructor(deploy, at);

        assert.strictEqual(below.error, 'invalid: constructor failed: stale oracle');
        assert.strictEqual(at.error, undefined);
        assert.strictEqual(at.constructorResult.success, true);
        assert.deepStrictEqual(oracleRead.firstCall.args, [ACTIVATION - 1, BLOCK_TIME, 1800]);
        assert.deepStrictEqual(oracleRead.secondCall.args, [ACTIVATION, BLOCK_TIME, 4500]);
    });
}

function registerControllerGuard(){
    it('flips a controller guard verdict at its host action block gate', async function(){
        armHourlyGate();
        let oracleRead = sinon.stub().callsFake(
            (blockIndex, blockTime, maxPriceAgeSeconds) => oracleDataResult(maxPriceAgeSeconds));
        let context = { config: hourlyConfig(), guardSavepointCounter: 0,
            actions: {
                protocolChanges: { isEnabled: async () => false },
                vm: {
                    execute: async options => {
                        let fresh = options.oracleData !== null;
                        return {
                            success: fresh,
                            error: fresh ? null : 'stale oracle',
                            gasUsed: 1,
                            returnValue: null,
                            stateChanges: [],
                            stateDeletes: [],
                            emittedActions: []
                        };
                    }
                }
            },
            util: { isNull: value => value === undefined || value === null,
                resolveGuardGasCeiling: () => 100, vmFailureStatus: error => error },
            indexerDb: {
                getContract: async () => ({ code: 'code' }),
                getStatusString: async () => 'valid',
                getContractState: async () => ({}),
                getOracleDataForVM: oracleRead,
                getCrossChainDataForVM: async () => ({}),
                getPollResultsForVM: async () => ({}),
                getContractStakeDataForVM: async () => ({}),
                createSavepoint: async () => 'guard-savepoint',
                countContractEmissionsForExecution: async () => 0,
                createContractExecution: async () => {},
                releaseSavepoint: async () => {}
            }
        };
        function hostData(blockIndex){ return { BLOCK_INDEX: blockIndex, BLOCK_TIME: BLOCK_TIME,
            SOURCE: 'source', ACTION_INDEX: 12, TX_HASH: 'tx', TX_VOUT: 0 }; }

        let below = await controllerGuard.runControllerGuard.call(
            context, { controllerIndex: 7, actionType: 'SEND', hostData: hostData(ACTIVATION - 1) },
            { MAX_CALL_DEPTH: 5 });
        let at = await controllerGuard.runControllerGuard.call(
            context, { controllerIndex: 7, actionType: 'SEND', hostData: hostData(ACTIVATION) },
            { MAX_CALL_DEPTH: 5 });

        assert.strictEqual(below.allow, false);
        assert.match(below.reason, /stale oracle/);
        assert.strictEqual(at.allow, true);
        assert.deepStrictEqual(oracleRead.firstCall.args, [ACTIVATION - 1, BLOCK_TIME, 1800]);
        assert.deepStrictEqual(oracleRead.secondCall.args, [ACTIVATION, BLOCK_TIME, 4500]);
    });
}

function registerVmExecution(){
    it('flips VM execution at its action block gate', async function(){
        armHourlyGate();
        let oracleRead = sinon.stub().callsFake(
            (blockIndex, blockTime, maxPriceAgeSeconds) => oracleDataResult(maxPriceAgeSeconds));
        let context = { config: hourlyConfig(), providerDeadlineWindows: {},
            actions: {
                protocolChanges: { isEnabled: async () => false },
                vm: {
                    execute: async options => {
                        let fresh = options.oracleData !== null;
                        return {
                            success: fresh,
                            error: fresh ? null : 'stale oracle',
                            gasUsed: 1,
                            returnValue: fresh ? 'fresh verdict' : null,
                            stateChanges: [],
                            stateDeletes: [],
                            emittedActions: []
                        };
                    }
                }
            },
            indexerDb: {
                getContractState: async () => ({}),
                getOracleDataForVM: oracleRead,
                getCrossChainDataForVM: async () => ({}),
                getPollResultsForVM: async () => ({}),
                getContractStakeDataForVM: async () => ({}),
                createSavepoint: async () => 'vm-savepoint',
                releaseSavepoint: async () => {}
            }
        };
        function buildRun(blockIndex){ return { data: { BLOCK_INDEX: blockIndex,
            BLOCK_TIME: BLOCK_TIME, CONTRACT_ACTION_INDEX: 7, ACTION_INDEX: 13, SOURCE: 'source',
            METHOD: 'run', TX_HASH: 'tx', TX_VOUT: 0, ROOT_ACTION_INDEX: 0 }, gasCost: 1,
            contractInfo: { code: 'code' } }; }

        let below = buildRun(ACTIVATION - 1);
        let at = buildRun(ACTIVATION);
        await runVm.runVmExecution.call(context, below, { GAS_CEILING: 100 });
        await runVm.runVmExecution.call(context, at, { GAS_CEILING: 100 });

        assert.strictEqual(below.vmError, 'stale oracle');
        assert.strictEqual(below.vmReturnValue, null);
        assert.strictEqual(at.vmError, null);
        assert.strictEqual(at.vmReturnValue, 'fresh verdict');
        assert.deepStrictEqual(oracleRead.firstCall.args, [ACTIVATION - 1, BLOCK_TIME, 1800]);
        assert.deepStrictEqual(oracleRead.secondCall.args, [ACTIVATION, BLOCK_TIME, 4500]);
    });
}

describe('hourly price age', function(){
    registerPriceAgeBasics();
    registerFeePricing();
    registerFeeSchedule();
    registerAttestationPricing();
    registerConstructorExecution();
    registerControllerGuard();
    registerVmExecution();
});
