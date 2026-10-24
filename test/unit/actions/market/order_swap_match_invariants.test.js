// Copyright (c) 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict';

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');

const OrderMatch = require('../../../../src/actions/order_match/index.js');
const gateRegistry = require('../../../../src/consensus/gate_registry.js');
const orderInfoMethods = require('../../../../src/db/orders/order_info.js');
const swapMatchMethods = require('../../../../src/db/swaps/swap_matches.js');
const expiredItemMethods = require('../../../../src/db/index_tables/expired_items.js');
const lifecycle = require('../../../../src/hub/table_lifecycle.js');
const { createMockIndexer } = require('../../../fixtures/mocks');

const EQUAL_PRICE_GATE = 'match_equal_price_oldest_first_activation.MATCH_EQUAL_PRICE_OLDEST_FIRST';
const EQUAL_PRICE_ENV = 'XC_MATCH_EQUAL_PRICE_OLDEST_FIRST_REGTEST_ACTIVATION';
const originalEqualPriceEnv = process.env[EQUAL_PRICE_ENV];

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

function shuffle(values, random) {
    let out = values.slice();
    for(let i = out.length - 1; i > 0; i--){
        let j = integer(random, 0, i);
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

describe('ORDER and SWAP matching invariants @regression @tier1', function () {
    afterEach(function () {
        sinon.restore();
        if(originalEqualPriceEnv === undefined) delete process.env[EQUAL_PRICE_ENV];
        else process.env[EQUAL_PRICE_ENV] = originalEqualPriceEnv;
    });

    // Drives four seeded, shuffled equal-price books through the real ORDER handler and
    // database sorter, and returns the matched and expected maker order for each seed.
    async function equalPriceBooks(envValue, blockIndex, oldestFirst) {
        if(envValue === undefined) delete process.env[EQUAL_PRICE_ENV];
        else process.env[EQUAL_PRICE_ENV] = envValue;
        const indexer = createMockIndexer();
        const handler = new OrderMatch(actionsContext(indexer));
        const seeds = [0x1, 0xC0FFEE, 0x5EED1234, 0xFFFFFFFF];
        let input = [];
        const db = {
            createAddress: sinon.stub().resolves(77),
            doQuery: sinon.stub().resolves([{ coin: 'BTC', action_index: 1 }]),
            getOrderInfoBatch: sinon.stub().callsFake(async () => input),
            util: indexer.util,
        };
        indexer.indexerDb.getOrderInfo.resolves(order());
        indexer.indexerDb.findOrderMatches.callsFake((data, oldestEqual) =>
            orderInfoMethods.findOrderMatches.call(db, data, oldestEqual));
        sinon.stub(handler, 'loadOrderLists').resolves({});

        const runs = [];
        for(const seed of seeds){
            const random = seeded(seed);
            const book = [];
            for(let i = 0; i < 24; i++){
                book.push({
                    ACTION_INDEX: 1000 + i,
                    GET_PRICE: String(integer(random, 1, 4)),
                });
            }
            input = shuffle(book, random);
            const expected = book.slice().sort((a, b) => {
                let priceOrder = Number(b.GET_PRICE) - Number(a.GET_PRICE);
                let indexOrder = oldestFirst ? a.ACTION_INDEX - b.ACTION_INDEX : b.ACTION_INDEX - a.ACTION_INDEX;
                return priceOrder || indexOrder;
            });
            const actual = [];
            handler.fillMatch = sinon.stub().callsFake(async (data, orderInfo, matchInfo) => {
                actual.push(matchInfo);
            });
            await handler.parse(null, {
                ACTION: 'ORDER_MATCH', ACTION_INDEX: 5000 + seed,
                BLOCK_INDEX: blockIndex, BLOCK_TIME: 1700000000,
            }, null);
            runs.push({ seed, actual: actual.map(row => row.ACTION_INDEX), expected: expected.map(row => row.ACTION_INDEX) });
        }
        return runs;
    }

    it('selects equal-price ORDER makers by oldest action index for every seeded permutation when armed', async function () {
        process.env[EQUAL_PRICE_ENV] = 'armed';
        assert.strictEqual(gateRegistry.activeAt(EQUAL_PRICE_GATE, 'mainnet', 'BTC', 99999999, null), false);
        assert.strictEqual(gateRegistry.activeAt(EQUAL_PRICE_GATE, 'testnet', 'BTC', 99999999, null), false);
        assert.strictEqual(gateRegistry.activeAt(EQUAL_PRICE_GATE, 'regtest', 'BTC', 0, null), true);

        for(const run of await equalPriceBooks('armed', 200, true)){
            assert.deepStrictEqual(run.actual, run.expected, 'seed ' + run.seed + ' must preserve price-time priority');
        }
    });

    it('keeps equal-price ORDER makers newest first below the activation height and when unset', async function () {
        for(const run of await equalPriceBooks('500', 200, false)){
            assert.deepStrictEqual(run.actual, run.expected, 'seed ' + run.seed + ' keeps the pre-activation order below height 500');
        }
        for(const run of await equalPriceBooks(undefined, 200, false)){
            assert.deepStrictEqual(run.actual, run.expected, 'seed ' + run.seed + ' keeps the pre-activation order with the gate unset');
        }
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
