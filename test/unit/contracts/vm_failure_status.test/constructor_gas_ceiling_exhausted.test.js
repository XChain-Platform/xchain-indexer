/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * DEPLOY constructor gas clamp on every path
 *
 * The EXECUTE settle clamps gasUsed to the run's ceiling on every path. The
 * constructor settle clamped only the resource family, so a constructor that
 * reported a generic 'error:' above GAS_CEILING added the raw overshoot to
 * totalGas, the hashed contract_executions.gas_used, and one that reported a
 * success above it was also billed the overshoot. Past the gas-ceiling
 * exhaustion activation the constructor is clamped on every path; below it
 * totalGas replays exactly as before.
 ********************************************************************/

'use strict';

const assert = require('assert');
const constructorRun = require('../../../../src/actions/deploy/constructor_run.js');
const { GAS_CEILING } = require('../../../../src/actions/deploy/constants.js');

const GAS_COST = 25000;
// The overshoot a swallowed exhaustion followed by a plain throw reports: up to
// one full charge past the ceiling, so close to twice it.
const OVERSHOOT = GAS_CEILING * 2 - 40000;

function deployFor(network, coin, result){
    let calls = [];
    return {
        calls,
        deploy: {
            config: { CHAIN: coin, COIN: coin, NETWORK: network,
                ORACLE_MAX_PRICE_AGE_SECONDS: 1800, ORACLE_MAX_PRICE_AGE_HOURLY_SECONDS: 4500 },
            providerDeadlineWindows: {},
            actions: {
                protocolChanges: { isEnabled: async () => false },
                vm: { execute: async (options) => { calls.push(options); return result; } },
            },
            indexerDb: {
                getOracleDataForVM: async () => ({}),
                getCrossChainDataForVM: async () => ({}),
                getPollResultsForVM: async () => ({}),
            },
        },
    };
}

function buildRun(coin, blockIndex){
    return {
        data: { BLOCK_INDEX: blockIndex, BLOCK_TIME: 4000000000, SOURCE: 'source',
            ACTION_INDEX: 11, TX_HASH: 'tx' },
        runConstructor: true,
        rootDiscrim: 0,
        code: 'code',
        contractAddress: 'C:' + coin + ':11',
        constructorParams: '',
        totalGas: GAS_COST,
    };
}

async function settle(network, coin, blockIndex, result){
    let { deploy, calls } = deployFor(network, coin, result);
    let run = buildRun(coin, blockIndex);
    await constructorRun.executeConstructor(deploy, run);
    assert.strictEqual(calls.length, 1, 'the constructor ran once');
    assert.strictEqual(calls[0].gasCeiling, GAS_CEILING);
    return run;
}

describe('DEPLOY constructor gas clamp on every path @regression @tier1', function () {

    it('clamps a generic constructor error above the ceiling once the activation is live', async function () {
        let run = await settle('regtest', 'BTC', 1, { success: false, error: 'error: x', gasUsed: OVERSHOOT });
        assert.strictEqual(run.totalGas, GAS_COST + GAS_CEILING);
        assert.strictEqual(run.error, 'invalid: constructor failed: error: x');
    });

    it('clamps a constructor success above the ceiling once the activation is live', async function () {
        let run = await settle('regtest', 'LTC', 1, { success: true, error: null, gasUsed: GAS_CEILING + 9 });
        assert.strictEqual(run.totalGas, GAS_COST + GAS_CEILING);
        assert.strictEqual(run.error, undefined);
    });

    it('bills a constructor under the ceiling at its real gas whether or not the activation is live', async function () {
        for (let network of ['regtest', 'mainnet', 'testnet']) {
            let run = await settle(network, 'DOGE', 5000000, { success: false, error: 'error: x', gasUsed: 7000 });
            assert.strictEqual(run.totalGas, GAS_COST + 7000, network);
        }
    });

    it('replays the raw overshoot before the activation, exactly as the unclamped settle did', async function () {
        for (let network of ['mainnet', 'testnet']) {
            for (let coin of ['BTC', 'LTC', 'DOGE']) {
                let failed = await settle(network, coin, 99999999, { success: false, error: 'error: x', gasUsed: OVERSHOOT });
                assert.strictEqual(failed.totalGas, GAS_COST + OVERSHOOT, coin + ':' + network);
                assert.strictEqual(failed.error, 'invalid: constructor failed: error: x');
                let succeeded = await settle(network, coin, 99999999, { success: true, error: null, gasUsed: GAS_CEILING + 9 });
                assert.strictEqual(succeeded.totalGas, GAS_COST + GAS_CEILING + 9, coin + ':' + network);
            }
        }
    });

    it('keeps the resource-family clamp on every network', async function () {
        for (let network of ['regtest', 'mainnet', 'testnet']) {
            let run = await settle(network, 'BTC', 1, { success: false, error: 'out_of_gas: used 1960000 of 1000000', gasUsed: OVERSHOOT });
            assert.strictEqual(run.totalGas, GAS_COST + GAS_CEILING, network);
        }
    });
});
