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
const Utility = require('../../src/utility.js');
const gateRegistry = require('../../src/consensus/gate_registry.js');
const { getCoinConfig } = require('../../src/coins/index.js');
const { maxPriceAgeSecondsAt } = require('../../src/utility/oracle_price_age.js');
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

describe('hourly price age', function(){
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

    it('refuses a fee-bearing action with a 3000 second old snapshot below the gate and accepts it at the gate', async function(){
        let activation = activationFor('BTC');
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
        let data = { BLOCK_INDEX: activation - 1, BLOCK_TIME: BLOCK_TIME, COIN: 'BTC' };

        let below = await util.validateNativeCoinFee(data, { AMOUNT: '1.0' }, db, feeOutput);
        assert.strictEqual(below.valid, false);
        assert.match(below.error, /stale beyond 1800s/);

        data.BLOCK_INDEX = activation;
        let at = await util.validateNativeCoinFee(data, { AMOUNT: '1.0' }, db, feeOutput);
        assert.strictEqual(at.valid, true, at.error);
        assert.strictEqual(at.oracleRound, 7);
    });

    it('passes the hourly age to fee pricing at the quoted block', async function(){
        let activation = activationFor('BTC');
        let calls = [];
        let indexerDb = {};
        let context = {
            config: hourlyConfig(),
            indexerDb: indexerDb,
            util: {
                bcnum: value => Number(value),
                bcformat: value => String(value),
                bclte: (left, right) => left <= right,
                getFeeOraclePrices: async (...args) => {
                    calls.push(args);
                    return { error: 'sentinel price stop' };
                }
            }
        };

        let result = await feePricing.priceFeeQuote.call(
            context, { blockIndex: activation, blockTime: BLOCK_TIME }, '1', null);

        assert.strictEqual(result.error, 'sentinel price stop');
        assert.deepStrictEqual(calls, [[indexerDb, 'BTC', activation, BLOCK_TIME, 4500]]);
    });

    it('passes the hourly age to the fee schedule price read at the tip block', async function(){
        let activation = activationFor('BTC');
        let calls = [];
        let indexerDb = {
            getLatestBlockIndex: async () => activation,
            getBlockTime: async () => BLOCK_TIME
        };
        let context = {
            config: hourlyConfig(),
            indexerDb: indexerDb,
            util: {
                getFeeOraclePrices: async (...args) => {
                    calls.push(args);
                    return { error: 'sentinel price stop' };
                }
            }
        };

        let result = await feeViews.getFeeSchedule.call(context);

        assert.strictEqual(result.maxPriceAgeSeconds, 4500);
        assert.deepStrictEqual(calls, [[indexerDb, 'BTC', activation, BLOCK_TIME, 4500]]);
    });

    it('passes the hourly age to attestation settlement at its action block', async function(){
        let activation = activationFor('BTC');
        let calls = [];
        let indexerDb = {};
        let expected = { xchainUsdPrice: '1', coinUsdPrice: '2' };
        let context = {
            config: hourlyConfig(),
            indexerDb: indexerDb,
            util: {
                getFeeOraclePrices: async (...args) => {
                    calls.push(args);
                    return expected;
                }
            }
        };

        let result = await attestSettle.broadcastFeePrices.call(
            context, {}, { BLOCK_INDEX: activation, BLOCK_TIME: BLOCK_TIME });

        assert.strictEqual(result, expected);
        assert.deepStrictEqual(calls, [[indexerDb, 'BTC', activation, BLOCK_TIME, 4500]]);
    });

    it('passes the hourly age to a deployment constructor at its action block', async function(){
        let activation = activationFor('BTC');
        let oracleCalls = [];
        let vmOptions;
        let oracleData = { BTC: 'hourly' };
        let deploy = {
            config: hourlyConfig(),
            providerDeadlineWindows: {},
            actions: {
                protocolChanges: { isEnabled: async () => false },
                vm: {
                    execute: async options => {
                        vmOptions = options;
                        return { success: true, gasUsed: 0 };
                    }
                }
            },
            indexerDb: {
                getOracleDataForVM: async (...args) => {
                    oracleCalls.push(args);
                    return oracleData;
                },
                getCrossChainDataForVM: async () => ({}),
                getPollResultsForVM: async () => ({})
            }
        };
        let run = {
            data: {
                BLOCK_INDEX: activation,
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

        await constructorRun.executeConstructor(deploy, run);

        assert.deepStrictEqual(oracleCalls, [[activation, BLOCK_TIME, 4500]]);
        assert.strictEqual(vmOptions.oracleData, oracleData);
    });

    it('passes the hourly age to a controller guard at its host action block', async function(){
        let activation = activationFor('BTC');
        let oracleCalls = [];
        let vmOptions;
        let context = {
            config: hourlyConfig(),
            actions: {
                protocolChanges: { isEnabled: async () => false },
                vm: {
                    execute: async options => {
                        vmOptions = options;
                        return { success: false, error: 'stopped', gasUsed: 0 };
                    }
                }
            },
            util: {
                isNull: value => value === undefined || value === null,
                resolveGuardGasCeiling: () => 100,
                vmFailureStatus: error => error
            },
            indexerDb: {
                getContract: async () => ({ code: 'code' }),
                getStatusString: async () => 'valid',
                getContractState: async () => ({}),
                getOracleDataForVM: async (...args) => {
                    oracleCalls.push(args);
                    return { BTC: 'hourly' };
                },
                getCrossChainDataForVM: async () => ({}),
                getPollResultsForVM: async () => ({}),
                getContractStakeDataForVM: async () => ({})
            }
        };
        let hostData = {
            BLOCK_INDEX: activation,
            BLOCK_TIME: BLOCK_TIME,
            SOURCE: 'source',
            ACTION_INDEX: 12,
            TX_HASH: 'tx',
            TX_VOUT: 0
        };

        let verdict = await controllerGuard.runControllerGuard.call(
            context, { controllerIndex: 7, actionType: 'SEND', hostData: hostData },
            { MAX_CALL_DEPTH: 5 });

        assert.strictEqual(verdict.allow, false);
        assert.deepStrictEqual(oracleCalls, [[activation, BLOCK_TIME, 4500]]);
        assert.deepStrictEqual(vmOptions.oracleData, { BTC: 'hourly' });
    });

    it('passes the hourly age to VM execution at its action block', async function(){
        let activation = activationFor('BTC');
        let oracleCalls = [];
        let vmOptions;
        let context = {
            config: hourlyConfig(),
            providerDeadlineWindows: {},
            actions: {
                protocolChanges: { isEnabled: async () => false },
                vm: {
                    execute: async options => {
                        vmOptions = options;
                        return {
                            success: false,
                            error: 'stopped',
                            gasUsed: 1,
                            emittedActions: []
                        };
                    }
                }
            },
            indexerDb: {
                getContractState: async () => ({}),
                getOracleDataForVM: async (...args) => {
                    oracleCalls.push(args);
                    return { BTC: 'hourly' };
                },
                getCrossChainDataForVM: async () => ({}),
                getPollResultsForVM: async () => ({}),
                getContractStakeDataForVM: async () => ({})
            }
        };
        let data = {
            BLOCK_INDEX: activation,
            BLOCK_TIME: BLOCK_TIME,
            CONTRACT_ACTION_INDEX: 7,
            ACTION_INDEX: 13,
            SOURCE: 'source',
            METHOD: 'run',
            TX_HASH: 'tx',
            TX_VOUT: 0,
            ROOT_ACTION_INDEX: 0
        };
        let run = { data: data, gasCost: 1, contractInfo: { code: 'code' } };

        await runVm.runVmExecution.call(context, run, { GAS_CEILING: 100 });

        assert.deepStrictEqual(oracleCalls, [[activation, BLOCK_TIME, 4500]]);
        assert.deepStrictEqual(vmOptions.oracleData, { BTC: 'hourly' });
    });
});
