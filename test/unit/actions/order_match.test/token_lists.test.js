// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// Order_Match token ALLOW_LIST and BLOCK_LIST checks, and the give-side
// bottleneck and max_give clamps.
// Part of the Order_Match suite; see ../order_match.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const sinon  = require('sinon');
const { createBaseData, createTokenInfo } = require('../../../fixtures/mocks');
const {
    BLOCK_TIME, makeOrderInfo, makeMatchInfo, useOrderMatchHarness,
} = require('./helpers/order_match_harness.js');

// Each test gets a fresh harness from useOrderMatchHarness; bind() hands it to
// the names the test bodies use.
let indexer, orderMatch;
const bind = (h) => { ({ indexer, orderMatch } = h); };

// ─── Token ALLOW_LIST / BLOCK_LIST (lines 72-77) ─────────────────────────

describe('Order_Match action handler @regression @tier2', function () {
    useOrderMatchHarness(bind);

    it('token GET_TICK ALLOW_LIST set → getList called for token allow list (line 72 true branch)', async function () {
        const orderAddr = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
        const matchAddr = 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM';

        // getTokenInfo for GET_TICK returns a tokenInfo with ALLOW_LIST set
        indexer.indexerDb.getTokenInfo
            .withArgs('RAREPEPE', sinon.match.any, sinon.match.any)
            .resolves(createTokenInfo({ TICK: 'RAREPEPE', TICK_ID: 10, ALLOW_LIST: '99', BLOCK_LIST: null }));
        indexer.indexerDb.getTokenInfo
            .withArgs('PEPECASH', sinon.match.any, sinon.match.any)
            .resolves(createTokenInfo({ TICK: 'PEPECASH', TICK_ID: 20, ALLOW_LIST: null, BLOCK_LIST: null }));

        // ALLOW_LIST '99' includes both addresses → match proceeds
        indexer.indexerDb.getList.resolves([orderAddr, matchAddr]);

        indexer.indexerDb.getOrderInfo.resolves(makeOrderInfo({
            GET_ADDRESS: orderAddr, GIVE_PRICE: '10', GET_PRICE: '0.1',
        }));
        indexer.indexerDb.findOrderMatches.resolves([makeMatchInfo({
            GET_ADDRESS: matchAddr, GET_PRICE: '10',
        })]);

        const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME, ACTION_INDEX: 1 });
        await orderMatch.parse([], data, false);

        // getList called for the token ALLOW_LIST (line 72 true branch)
        sinon.assert.called(indexer.indexerDb.getList);
        sinon.assert.calledOnce(indexer.indexerDb.createOrderMatch);
    });

    it('token GIVE_TICK BLOCK_LIST set → skip when GET_ADDRESS is in block list (line 77 true branch)', async function () {
        const matchAddr = 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM';

        indexer.indexerDb.getTokenInfo
            .withArgs('RAREPEPE', sinon.match.any, sinon.match.any)
            .resolves(createTokenInfo({ TICK: 'RAREPEPE', TICK_ID: 10, ALLOW_LIST: null, BLOCK_LIST: null }));
        indexer.indexerDb.getTokenInfo
            .withArgs('PEPECASH', sinon.match.any, sinon.match.any)
            .resolves(createTokenInfo({ TICK: 'PEPECASH', TICK_ID: 20, ALLOW_LIST: null, BLOCK_LIST: '88' }));

        // BLOCK_LIST '88' contains match GET_ADDRESS → match skipped
        indexer.indexerDb.getList.resolves([matchAddr]);

        indexer.indexerDb.getOrderInfo.resolves(makeOrderInfo({ GIVE_PRICE: '10', GET_PRICE: '0.1' }));
        indexer.indexerDb.findOrderMatches.resolves([makeMatchInfo({ GET_ADDRESS: matchAddr, GET_PRICE: '10' })]);

        const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME, ACTION_INDEX: 1 });
        await orderMatch.parse([], data, false);

        sinon.assert.notCalled(indexer.indexerDb.createOrderMatch);
    });
});

describe('Order_Match action handler @regression @tier2', function () {
    useOrderMatchHarness(bind);

    it('getTokenInfo returns null for both ticks → no allow/block list fetched, match proceeds (lines 72-77 null-guard)', async function () {
        // Covers the `getTokenInfo && ...` false branch (getTokenInfo is null)
        indexer.indexerDb.getTokenInfo.resolves(null);
        indexer.indexerDb.getOrderInfo.resolves(makeOrderInfo());
        indexer.indexerDb.findOrderMatches.resolves([makeMatchInfo()]);

        const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME, ACTION_INDEX: 1 });
        await orderMatch.parse([], data, false);

        // getList must not be called when both tokenInfos are null
        sinon.assert.notCalled(indexer.indexerDb.getList);
        sinon.assert.calledOnce(indexer.indexerDb.createOrderMatch);
    });

    it('giveTokenInfo BLOCK_LIST set → skip when GET_ADDRESS is in give-token block list (line 77, line 190 true branch)', async function () {
        const matchAddr = 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM';

        // giveTokenInfo has BLOCK_LIST set; GET_TICK tokenInfo has none
        indexer.indexerDb.getTokenInfo
            .withArgs('RAREPEPE', sinon.match.any, sinon.match.any)
            .resolves(createTokenInfo({ TICK: 'RAREPEPE', TICK_ID: 10, ALLOW_LIST: null, BLOCK_LIST: '77' }));
        indexer.indexerDb.getTokenInfo
            .withArgs('PEPECASH', sinon.match.any, sinon.match.any)
            .resolves(createTokenInfo({ TICK: 'PEPECASH', TICK_ID: 20, ALLOW_LIST: null, BLOCK_LIST: null }));

        // BLOCK_LIST '77' contains matchAddr
        indexer.indexerDb.getList.resolves([matchAddr]);

        indexer.indexerDb.getOrderInfo.resolves(makeOrderInfo({ GIVE_PRICE: '10', GET_PRICE: '0.1' }));
        indexer.indexerDb.findOrderMatches.resolves([makeMatchInfo({ GET_ADDRESS: matchAddr, GET_PRICE: '10' })]);

        const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME, ACTION_INDEX: 1 });
        await orderMatch.parse([], data, false);

        sinon.assert.notCalled(indexer.indexerDb.createOrderMatch);
    });
});

describe('Order_Match action handler @regression @tier2', function () {
    useOrderMatchHarness(bind);

    it('matchInfo BLOCK_LIST set → skip when order GET_ADDRESS is in match block list (lines 193-194 true branch)', async function () {
        const orderAddr = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';

        indexer.indexerDb.getTokenInfo
            .withArgs('RAREPEPE', sinon.match.any, sinon.match.any)
            .resolves(createTokenInfo({ TICK: 'RAREPEPE', TICK_ID: 10, ALLOW_LIST: null, BLOCK_LIST: null }));
        indexer.indexerDb.getTokenInfo
            .withArgs('PEPECASH', sinon.match.any, sinon.match.any)
            .resolves(createTokenInfo({ TICK: 'PEPECASH', TICK_ID: 20, ALLOW_LIST: null, BLOCK_LIST: null }));

        indexer.indexerDb.getOrderInfo.resolves(makeOrderInfo({ GET_ADDRESS: orderAddr, GIVE_PRICE: '10', GET_PRICE: '0.1' }));
        indexer.indexerDb.findOrderMatches.resolves([makeMatchInfo({ BLOCK_LIST: '55', GET_PRICE: '10' })]);
        // matchInfo BLOCK_LIST includes orderAddr
        indexer.indexerDb.getList.resolves([orderAddr]);

        const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME, ACTION_INDEX: 1 });
        await orderMatch.parse([], data, false);

        sinon.assert.notCalled(indexer.indexerDb.createOrderMatch);
    });

    // ─── Give-side bottleneck (lines 143-145) ────────────────────────────────

    it('give-side is the bottleneck (give_from_get > max_give) → give_amount clamped, get derived (lines 143-145)', async function () {
        // max_give = 10, max_get = 1000, GET_PRICE=1 → give_from_get = 1000 >> 10 → give-side bottleneck
        // give_amount = max_give = 10; get_amount = 10 * GIVE_PRICE = 10 * 0.5 = 5
        // Price check: matchInfo.GET_PRICE(1) <= orderInfo.GIVE_PRICE(0.5)? 1 > 0.5 → mismatch → need GIVE_PRICE >= 1
        // Use GIVE_PRICE=2, GET_PRICE=1: give_from_get = 1000 * 1 = 1000 > max_give=10 → give-side bottleneck
        // Price check: matchInfo.GET_PRICE(1) <= orderInfo.GIVE_PRICE(2) → passes
        indexer.indexerDb.getOrderInfo.resolves(makeOrderInfo({
            GIVE_REMAINING: '10',
            GET_REMAINING:  '1000',
            GIVE_PRICE:     '2',
            GET_PRICE:      '1',
        }));
        indexer.indexerDb.findOrderMatches.resolves([makeMatchInfo({
            GIVE_REMAINING: '1000',
            GET_REMAINING:  '10',
            GET_PRICE:      '1',   // <= GIVE_PRICE(2) → price check passes
        })]);

        const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME, ACTION_INDEX: 1 });
        await orderMatch.parse([], data, false);

        // give-side bottleneck → match proceeds, createOrderMatch called
        sinon.assert.calledOnce(indexer.indexerDb.createOrderMatch);
    });
});

describe('Order_Match action handler @regression @tier2', function () {
    useOrderMatchHarness(bind);

    it('max_give = orderInfo.GIVE_REMAINING when matchInfo.GET_REMAINING is larger (line 136 false branch)', async function () {
        // matchInfo.GET_REMAINING(200) > orderInfo.GIVE_REMAINING(10) → max_give = orderInfo.GIVE_REMAINING
        indexer.indexerDb.getOrderInfo.resolves(makeOrderInfo({
            GIVE_REMAINING: '10',
            GET_REMAINING:  '100',
            GIVE_PRICE:     '10',
            GET_PRICE:      '0.1',
        }));
        indexer.indexerDb.findOrderMatches.resolves([makeMatchInfo({
            GIVE_REMAINING: '200',  // larger than order's GET_REMAINING
            GET_REMAINING:  '200',  // larger than order's GIVE_REMAINING → max_give = order.GIVE_REMAINING
            GET_PRICE:      '10',
        })]);

        const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME, ACTION_INDEX: 1 });
        await orderMatch.parse([], data, false);

        sinon.assert.calledOnce(indexer.indexerDb.createOrderMatch);
    });
});
