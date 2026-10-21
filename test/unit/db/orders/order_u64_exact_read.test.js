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
 ********************************************************************/

'use strict';

const assert = require('assert');

const orderInfo = require('../../../../src/db/orders/order_info.js');
const crossChainOffers = require('../../../../src/db/orders/cross_chain_offers.js');

const U64_MAX = '18446744073709551615';

function util(){
    return {
        isNull: value => value === null || value === undefined,
        isNumeric: value => typeof value === 'bigint' || (!isNaN(parseFloat(value)) && isFinite(value)),
        getPrice: () => '1'
    };
}

describe('exact u64 order reads @regression @tier1', function(){
    it('keeps creation expiration and list ids exact', async function(){
        let db = {
            config: { COIN: 'BTC' },
            util: util(),
            doQuery: async () => [{
                action_index: '7',
                expiration: U64_MAX,
                allow_list: '9007199254740993',
                block_list: '42'
            }],
            getOrderEdits: async () => ({ expiration: false, allow_list: false, block_list: false }),
            getOrderAmountsRemaining: async () => ['10', '20']
        };

        let order = await orderInfo.getOrderInfo.call(db, null, 7);

        assert.strictEqual(order.EXPIRATION, U64_MAX);
        assert.strictEqual(order.ALLOW_LIST, '9007199254740993');
        assert.strictEqual(order.BLOCK_LIST, 42);

        db.doQuery = async () => [{
            action_index: '8',
            expiration: null,
            allow_list: null,
            block_list: null
        }];

        order = await orderInfo.getOrderInfo.call(db, null, 8);

        assert.strictEqual(order.EXPIRATION, 0);
        assert.strictEqual(order.ALLOW_LIST, 0);
        assert.strictEqual(order.BLOCK_LIST, 0);
    });

    it('keeps edited expiration and list ids exact', async function(){
        let db = {
            util: util(),
            doQuery: async () => [{
                expiration: U64_MAX,
                allow_list: 9007199254740993n,
                block_list: '42'
            }]
        };

        let edit = await orderInfo.getOrderEdits.call(db, 7);

        assert.deepStrictEqual(edit, {
            expiration: U64_MAX,
            allow_list: '9007199254740993',
            block_list: 42
        });
    });

    it('keeps cross-chain offer expiration and list ids exact', async function(){
        let db = {
            util: util(),
            doQuery: async () => [{
                kind: 'swap',
                action_index: '7',
                give_coin: 'BTC',
                give_tick: 'GIVE',
                give_amount: '10',
                give_ownership: '0',
                get_coin: 'LTC',
                get_tick: 'GET',
                get_amount: '20',
                get_ownership: '0',
                get_address: 'destination',
                source: 'source',
                expiration: U64_MAX,
                allow_list: '9007199254740993',
                block_list: '42',
                payout_legs: null,
                block_index: '6'
            }]
        };

        let offers = await crossChainOffers.getOpenCrossChainOffers.call(db, 10, null, null, null);

        assert.strictEqual(offers[0].expiration, U64_MAX);
        assert.strictEqual(offers[0].allow_list, '9007199254740993');
        assert.strictEqual(offers[0].block_list, 42);
    });
});
