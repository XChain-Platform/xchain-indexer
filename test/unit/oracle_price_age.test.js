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
const fs = require('fs');
const path = require('path');
const Utility = require('../../src/utility.js');
const gateRegistry = require('../../src/consensus/gate_registry.js');
const { getCoinConfig } = require('../../src/coins/index.js');
const { maxPriceAgeSecondsAt } = require('../../src/utility/oracle_price_age.js');

const GATE = 'oracle_price_age_hourly_activation.ORACLE_PRICE_AGE_HOURLY_ACTIVATION';
const NETWORK = 'testnet';
const CHAINS = ['BTC', 'LTC', 'DOGE'];
const FEE_DESTINATION = 'feeDestinationAddr111111111111111';
const BLOCK_TIME = 10_000;
const SNAPSHOT_TIME = BLOCK_TIME - 3_000;

function compactSource(relativePath){
    return fs.readFileSync(path.join(__dirname, '../..', relativePath), 'utf8').replace(/\s+/g, '');
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
        let activation = gateRegistry.get(GATE)['BTC:' + NETWORK];
        assert.strictEqual(maxPriceAgeSecondsAt({}, NETWORK, 'BTC', activation), 1800);
    });

    it('refuses a fee-bearing action with a 3000 second old snapshot below the gate and accepts it at the gate', async function(){
        let activation = gateRegistry.get(GATE)['BTC:' + NETWORK];
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

    let consumerWiring = [
        {
            name: 'fee pricing',
            file: 'src/actions/actions_class/fee_pricing.js',
            select: "maxPriceAgeSecondsAt(this.config,this.config['NETWORK'],coin,blockIndex)",
            read: 'getFeeOraclePrices(this.indexerDb,coin,blockIndex,refTime,maxPriceAgeSeconds)'
        },
        {
            name: 'fee schedule views',
            file: 'src/actions/actions_class/fee_views.js',
            select: "maxPriceAgeSecondsAt(this.config,this.config['NETWORK'],coin,blockIndex)",
            read: 'getFeeOraclePrices(this.indexerDb,coin,blockIndex,refTime,maxPriceAgeSeconds)'
        },
        {
            name: 'attestation settlement',
            file: 'src/actions/attest/settle.js',
            select: "maxPriceAgeSecondsAt(this.config,this.config['NETWORK'],this.config['COIN'],data['BLOCK_INDEX'])",
            read: "getFeeOraclePrices(this.indexerDb,this.config['COIN'],data['BLOCK_INDEX'],data['BLOCK_TIME'],maxPriceAgeSeconds)"
        },
        {
            name: 'deployment constructors',
            file: 'src/actions/deploy/constructor_run.js',
            select: "maxPriceAgeSecondsAt(deploy.config,deploy.config['NETWORK'],deploy.config['COIN'],data['BLOCK_INDEX'])",
            read: "getOracleDataForVM(data['BLOCK_INDEX'],data['BLOCK_TIME'],maxPriceAgeSeconds)"
        },
        {
            name: 'controller guards',
            file: 'src/actions/execute/controller_guard.js',
            select: "maxPriceAgeSecondsAt(this.config,this.config['NETWORK'],this.config['COIN'],hostData['BLOCK_INDEX'])",
            read: "getOracleDataForVM(hostData['BLOCK_INDEX'],hostData['BLOCK_TIME'],maxPriceAgeSeconds)"
        },
        {
            name: 'VM execution',
            file: 'src/actions/execute/run_vm.js',
            select: "maxPriceAgeSecondsAt(this.config,this.config['NETWORK'],this.config['COIN'],data['BLOCK_INDEX'])",
            read: "getOracleDataForVM(data['BLOCK_INDEX'],data['BLOCK_TIME'],maxPriceAgeSeconds)"
        }
    ];

    for(let consumer of consumerWiring){
        it('wires the action block age through ' + consumer.name, function(){
            let source = compactSource(consumer.file);
            assert.ok(source.includes(consumer.select), consumer.file + ' must select age at its action block');
            assert.ok(source.includes(consumer.read), consumer.file + ' must pass selected age to its oracle read');
        });
    }
});
