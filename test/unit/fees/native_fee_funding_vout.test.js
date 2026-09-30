// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const Utility = require('../../../src/utility.js');

const FEE_DEST = 'feeDestinationAddr111111111111111';

function makeUtil(coin, feeDestination){
    let util = new Utility();
    util.config['COIN']                        = coin;
    util.config['ADDRESS']                     = Object.assign({}, util.config['ADDRESS'] || {}, { FEE_DESTINATION: feeDestination });
    util.config['FEE_TOLERANCE_MIN']           = '0.95';
    util.config['FEE_TOLERANCE_MAX']           = '1.10';
    util.config['ORACLE_MAX_PRICE_AGE_SECONDS']= 1800;
    return util;
}

function priceStub(prices){
    return {
        getLatestPrice: async (pair) => {
            if(!(pair in prices) || prices[pair] == null)
                return null;
            return { price: prices[pair], roundNumber: 7, block_timestamp: 1000 };
        }
    };
}

describe('native fee funding vout @regression @tier1', function () {
    for(let coin of ['DOGE', 'BTC']){
        let data = { BLOCK_INDEX: 100, BLOCK_TIME: 1000, COIN: coin };
        let outputs = [{ vout: 1000001, address: FEE_DEST, value: '5.00000000' }];

        it(`detects a ${coin} fee stored in the funding vout domain`, function () {
            let util = makeUtil(coin, FEE_DEST);
            assert.strictEqual(util.detectFeePaymentMode(data, null, outputs), 'native');
        });

        it(`validates a ${coin} fee stored in the funding vout domain`, async function () {
            let util = makeUtil(coin, FEE_DEST);
            let db = priceStub({ 'XCHAIN/USD': '1.00000000', [`${coin}/USD`]: '0.10000000' });
            let result = await util.validateNativeCoinFee(data, { AMOUNT: '0.5' }, db, outputs);
            assert.strictEqual(result.valid, true);
            assert.strictEqual(result.nativeCoinAmount, '5.00000000');
        });

        it(`applies the ${coin} fallback when the funding output has another address`, function () {
            let util = makeUtil(coin, FEE_DEST);
            let otherOutputs = [{ vout: 1000001, address: 'anotherAddress', value: '5.00000000' }];
            let expected = coin === 'DOGE' ? 'rejected' : 'xchain';
            assert.strictEqual(util.detectFeePaymentMode(data, null, otherOutputs), expected);
        });
    }
});
