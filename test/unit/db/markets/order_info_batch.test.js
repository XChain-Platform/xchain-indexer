'use strict';

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
 **********************************************************************/

const assert = require('assert');
const sinon = require('sinon');

const Utility = require('../../../../src/utility.js');
const methods = require('../../../../src/db/orders/order_info.js');

const INFO_ROWS = [
    {
        action_index: '10', give_tick: 'GIVE10', give_amount: '10', give_ownership: '0',
        get_coin: 'DOGE', get_tick: 'GET10', get_amount: '20', get_ownership: '0',
        source: 'source-10', get_address: 'destination-10', expiration: '100',
        allow_list: '7', block_list: null, memo: 'memo-10', status: 'valid',
        order_status: 'open', payout_legs: null, block_index: '500', block_time: '1000'
    },
    {
        action_index: '20', give_tick: 'GIVE20', give_amount: null, give_ownership: '1',
        get_coin: 'LTC', get_tick: 'GET20', get_amount: '4', get_ownership: '0',
        source: 'source-20', get_address: 'destination-20', expiration: null,
        allow_list: null, block_list: '8', memo: null, status: 'valid',
        order_status: 'open', payout_legs: '[]', block_index: '501', block_time: '1001'
    }
];

const EDIT_ROWS = [
    { order_action_index: 10, expiration: '120', allow_list: null, block_list: null },
    { order_action_index: 10, expiration: null, allow_list: '0', block_list: '12' },
    { order_action_index: 20, expiration: '220', allow_list: '9', block_list: null }
];

const OPENING_ROWS = [
    {
        action_index: 10, give_coin_id: 1, give_tick_id: 2, give_amount: '10', give_ownership: 0,
        get_coin_id: 3, get_tick_id: 4, get_amount: '20', get_ownership: 0
    },
    {
        action_index: 20, give_coin_id: 1, give_tick_id: 5, give_amount: null, give_ownership: 1,
        get_coin_id: 6, get_tick_id: 7, get_amount: '4', get_ownership: 0
    }
];

const MATCH_ROWS = [
    { action_index: 30, give_action_index: 10, get_action_index: 99, give_amount: '2', get_amount: '4' },
    { action_index: 31, give_action_index: 88, get_action_index: 20, give_amount: '0.25', get_amount: '1' }
];

function requestedIndexes(query, args){
    if(/orders o1/.test(query))
        return /o1\.action_index IN/.test(query) ? args : [args[args.length - 1]];
    if(/order_edits o/.test(query))
        return /o\.order_action_index IN/.test(query) ? args.slice(0, -1) : [args[0]];
    if(/order_matches m/.test(query))
        return /m\.give_action_index IN/.test(query) ? args.slice(0, (args.length - 2) / 2) : [args[0]];
    return /o\.action_index IN/.test(query) ? args.slice(0, -1) : [args[0]];
}

function resultFor(query, args){
    const wanted = new Set(requestedIndexes(query, args).map(String));
    if(/orders o1/.test(query)){
        let rows = INFO_ROWS.filter(row => wanted.has(String(row.action_index)));
        if(/c1\.coin=\?/.test(query)) rows = rows.filter(row => row.get_coin === args[0]);
        return rows;
    }
    if(/order_edits o/.test(query))
        return EDIT_ROWS.filter(row => wanted.has(String(row.order_action_index)));
    if(/order_matches m/.test(query))
        return MATCH_ROWS.filter(row => wanted.has(String(row.give_action_index)) || wanted.has(String(row.get_action_index)));
    return OPENING_ROWS.filter(row => wanted.has(String(row.action_index)));
}

function makeDb(calls){
    return Object.assign({
        config: { COIN: 'BTC' },
        util: new Utility({ COIN: 'BTC', NETWORK: 'regtest' }),
        async doQuery(query, args){
            calls.push({ query, args });
            return resultFor(query, args);
        }
    }, methods);
}

describe('getOrderInfoBatch() @regression @tier1', function () {
    afterEach(function () {
        sinon.restore();
    });

    it('deep-equals per-row getOrderInfo while using four set queries', async function () {
        const candidates = [
            { coin: 'DOGE', action_index: 10 },
            { coin: null, action_index: 20 },
            { coin: 'BTC', action_index: 10 }
        ];
        const sequentialCalls = [];
        const sequentialDb = makeDb(sequentialCalls);
        const expected = [];
        for(const row of candidates)
            expected.push(await sequentialDb.getOrderInfo(row.coin, row.action_index));

        const batchCalls = [];
        const actual = await makeDb(batchCalls).getOrderInfoBatch(candidates);

        assert.deepStrictEqual(actual, expected);
        assert.strictEqual(batchCalls.length, 4);
        assert.strictEqual(sequentialCalls.length, 9);
        assert.deepStrictEqual(batchCalls[0].args, [10, 20]);
        assert.deepStrictEqual(batchCalls[1].args, [10, 20, 'valid']);
        assert.deepStrictEqual(batchCalls[2].args, [10, 20, 'valid']);
        assert.deepStrictEqual(batchCalls[3].args, [10, 20, 10, 20, 'valid', 'pending_coinpay']);
        for(const call of batchCalls)
            assert.match(call.query, / IN \(\?, \?\)/);
    });

    it('does no database work for an empty candidate set', async function () {
        const calls = [];
        assert.deepStrictEqual(await makeDb(calls).getOrderInfoBatch([]), []);
        assert.deepStrictEqual(calls, []);
    });

    it('loads matcher candidates through the batch method once', async function () {
        const candidates = [
            { coin: 'DOGE', action_index: 10 },
            { coin: 'LTC', action_index: 20 }
        ];
        const hydrated = [{ ACTION_INDEX: 10 }, { ACTION_INDEX: 20 }];
        const sorted = hydrated.slice().reverse();
        const db = {
            createAddress: sinon.stub().resolves(77),
            doQuery: sinon.stub().resolves(candidates),
            getOrderInfo: sinon.stub().rejects(new Error('per-row lookup must not run')),
            getOrderInfoBatch: sinon.stub().resolves(hydrated),
            util: { sortPriceActionIndex: sinon.stub().returns(sorted) }
        };

        const result = await methods.findOrderMatches.call(db, { SOURCE: 'source', ACTION_INDEX: 5 });

        assert.strictEqual(result, sorted);
        sinon.assert.calledOnceWithExactly(db.getOrderInfoBatch, candidates);
        sinon.assert.notCalled(db.getOrderInfo);
        sinon.assert.calledOnceWithExactly(db.util.sortPriceActionIndex, hydrated);
    });
});
