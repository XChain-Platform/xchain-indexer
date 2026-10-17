// Copyright (c) 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict';

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');

const OrderMatch = require('../../../../src/actions/order_match/index.js');
const orderInfoMethods = require('../../../../src/db/orders/order_info.js');
const swapMatchMethods = require('../../../../src/db/swaps/swap_matches.js');
const expiredItemMethods = require('../../../../src/db/index_tables/expired_items.js');
const lifecycle = require('../../../../src/hub/table_lifecycle.js');
const { createMockIndexer } = require('../../../fixtures/mocks');

function actionsContext(indexer) {
    return {
        config: indexer.config,
        util: indexer.util,
        mapper: indexer.mapper,
        decoderDb: indexer.decoderDb,
        indexerDb: indexer.indexerDb,
        protocolChanges: {
            isDefined: sinon.stub().returns(true),
            isEnabled: sinon.stub().resolves(true),
        },
        processAction: sinon.stub().resolves(),
    };
}

function order(overrides = {}) {
    return {
        ACTION_INDEX: 10,
        SOURCE: 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH',
        GIVE_COIN: 'BTC', GIVE_TICK: 'ASSET_A', GIVE_AMOUNT: '10', GIVE_REMAINING: '10',
        GET_COIN: 'BTC', GET_TICK: 'ASSET_B', GET_AMOUNT: '20', GET_REMAINING: '20',
        GIVE_PRICE: '2', GET_PRICE: '0.5',
        GET_ADDRESS: 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH',
        GIVE_OWNERSHIP: 0, GET_OWNERSHIP: 0,
        ALLOW_LIST: null, BLOCK_LIST: null, PAYOUT_LEGS: null,
        ORDER_STATUS: 'open',
        ...overrides,
    };
}

function counterOrder(overrides = {}) {
    return order({
        ACTION_INDEX: 20,
        SOURCE: 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM',
        GIVE_TICK: 'ASSET_B', GIVE_AMOUNT: '20', GIVE_REMAINING: '20',
        GET_TICK: 'ASSET_A', GET_AMOUNT: '10', GET_REMAINING: '10',
        GIVE_PRICE: '0.5', GET_PRICE: '2',
        GET_ADDRESS: 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM',
        ...overrides,
    });
}

function seeded(seed) {
    let state = seed >>> 0;
    return function next() {
        state += 0x6D2B79F5;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

function integer(random, min, max) {
    return min + Math.floor(random() * (max - min + 1));
}

function scaledAmount(units, decimals) {
    if(decimals === 0) return String(units);
    let digits = String(units).padStart(decimals + 1, '0');
    return digits.slice(0, -decimals) + '.' + digits.slice(-decimals);
}

describe('ORDER and SWAP matching invariants @regression @tier1', function () {
    afterEach(function () {
        sinon.restore();
    });

    it('conserves both assets exactly across seeded partial fills and payout splits', async function () {
        const seeds = [0xB00C, 0xDEC0DE, 0x12345678, 0xA5A5A5A5];

        for(const seed of seeds){
            const random = seeded(seed);
            const indexer = createMockIndexer();
            const handler = new OrderMatch(actionsContext(indexer));

            for(let sample = 0; sample < 40; sample++){
                const aDecimals = integer(random, 0, 8);
                const bDecimals = integer(random, 0, 8);
                const takerGive = scaledAmount(integer(random, 1, 100000000), aDecimals);
                const takerGet = scaledAmount(integer(random, 1, 100000000), bDecimals);
                const makerGive = scaledAmount(integer(random, 1, 100000000), bDecimals);
                const makerGet = scaledAmount(integer(random, 1, 100000000), aDecimals);
                const orderInfo = order({
                    GIVE_AMOUNT: takerGive, GIVE_REMAINING: takerGive,
                    GET_AMOUNT: takerGet, GET_REMAINING: takerGet,
                    GIVE_PRICE: indexer.util.bcdiv(takerGet, takerGive, 64),
                    GET_PRICE: indexer.util.bcdiv(takerGive, takerGet, 64),
                    PAYOUT_LEGS: JSON.stringify([{ to: 'order-policy', bps: integer(random, 0, 5000) }]),
                });
                const matchInfo = counterOrder({
                    GIVE_AMOUNT: makerGive, GIVE_REMAINING: makerGive,
                    GET_AMOUNT: makerGet, GET_REMAINING: makerGet,
                    PAYOUT_LEGS: JSON.stringify([{ to: 'maker-policy', bps: integer(random, 0, 5000) }]),
                });
                const runningOrder = { GIVE_REMAINING: takerGive, GET_REMAINING: takerGet };
                const fill = handler.computeFillAmounts(orderInfo, matchInfo, runningOrder, {
                    giveTokenInfo: { DECIMALS: aDecimals },
                    getTokenInfo: { DECIMALS: bDecimals },
                });

                assert.ok(!indexer.util.bcgt(fill.give_amount, takerGive));
                assert.ok(!indexer.util.bcgt(fill.give_amount, makerGet));
                assert.ok(!indexer.util.bcgt(fill.get_amount, takerGet));
                assert.ok(!indexer.util.bcgt(fill.get_amount, makerGive));

                indexer.indexerDb.getTokenInfo.callsFake(async tick => ({
                    DECIMALS: tick === 'ASSET_A' ? aDecimals : bDecimals,
                }));
                const credits = [];
                const escrows = [];
                const data = { ACTION_INDEX: 8000 + sample, BLOCK_INDEX: 300 };
                await handler.settleOrderGiveSide(data, orderInfo, matchInfo, fill, credits, escrows);
                await handler.settleMatchGiveSide(data, orderInfo, matchInfo, fill, credits, escrows);

                for(const tick of ['ASSET_A', 'ASSET_B']){
                    let net = '0';
                    for(const row of credits.concat(escrows)){
                        if(row[0] === tick) net = indexer.util.bcadd(net, row[1], 64);
                    }
                    assert.ok(!indexer.util.bcgt(net, '0') && !indexer.util.bclt(net, '0'),
                        'seed ' + seed + ' sample ' + sample + ' must conserve ' + tick + ', net=' + net);
                }
            }
        }
    });

    it('excludes self-matches and applies explicit deterministic candidate ordering', async function () {
        let orderSql = '';
        await orderInfoMethods.findOrderMatches.call({
            createAddress: async () => 77,
            doQuery: async query => { orderSql = query; return []; },
        }, { SOURCE: 'same-source', ACTION_INDEX: 101 });
        assert.match(orderSql, /a1\.source_id!=\?/);
        assert.match(orderSql, /ORDER BY\s+o2\.action_index ASC/);

        let swapSql = '';
        await swapMatchMethods.findSwapMatches.call({
            createAddress: async () => 77,
            doQuery: async query => { swapSql = query; return []; },
        }, { SOURCE: 'same-source', ACTION_INDEX: 102 });
        assert.match(swapSql, /a1\.source_id!=\?/);
        assert.match(swapSql, /ORDER BY\s+s2\.action_index ASC/);
    });

    it('keeps offers matchable at the exact expiration second and expires them afterward', async function () {
        let sql = '';
        let args = [];
        const rows = await expiredItemMethods.getExpiredItems.call({
            util: {
                isNull: value => value === null || value === undefined || value === '',
            },
            doQuery: async (query, values) => { sql = query; args = values; return []; },
        }, 1700000000);
        assert.deepStrictEqual(rows, []);
        assert.deepStrictEqual(args, [1700000000, 1700000000, 1700000000]);
        assert.strictEqual((sql.match(/< \?/g) || []).length, 3);
        assert.strictEqual((sql.match(/<= \?/g) || []).length, 0);
        assert.match(sql, /ORDER BY action_index ASC/);
    });

    it('classifies every match-touched row for action-scoped rollback', function () {
        const tables = new Set(lifecycle.rollbackTables().dataTables);
        const touched = [
            'actions', 'credits', 'debits', 'escrows',
            'orders', 'order_matches', 'order_statuses',
            'swaps', 'swap_matches', 'swap_statuses',
        ];
        for(const table of touched)
            assert.ok(tables.has(table), table + ' must be deleted by action-index rollback');
    });
});
