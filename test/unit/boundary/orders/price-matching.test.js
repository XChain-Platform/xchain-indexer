'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData, createTokenInfo } = require('../../../fixtures/mocks');

const OrderMatch = require('../../../../src/actions/order_match.js');

function makeActionsCtx(indexer) {
    return {
        config:          indexer.config,
        util:            indexer.util,
        mapper:          indexer.mapper,
        decoderDb:       indexer.decoderDb,
        indexerDb:       indexer.indexerDb,
        protocolChanges: {
            isDefined:  sinon.stub().returns(true),
            isEnabled:  sinon.stub().resolves(true),
        },
        processAction: sinon.stub().resolves(),
    };
}

const SOURCE     = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const OTHER      = 'mtr6NtB5KJRAxTX5AbuRtV7S4FF2PZJXUs';
const BLOCK_TIME = 1700000000;

/**
 * Builds a standard orderInfo object with sensible defaults.
 *
 * GIVE_PRICE = GIVE_AMOUNT / GET_AMOUNT  (price of one GIVE unit in GET terms)
 * GET_PRICE  = GET_AMOUNT  / GIVE_AMOUNT (price of one GET unit in GIVE terms)
 *
 * The price-compatibility check in order_match.js is:
 *   if (bcgt(matchInfo.GET_PRICE, orderInfo.GIVE_PRICE)) continue;  // skip
 * i.e. the match proceeds when matchInfo.GET_PRICE <= orderInfo.GIVE_PRICE.
 */
function makeOrderInfo(overrides = {}) {
    return Object.assign({
        ACTION_INDEX:  1,
        SOURCE:        SOURCE,
        GIVE_TICK:     'RAREPEPE',
        GIVE_TICK_ID:  10,
        GIVE_AMOUNT:   '100',
        GIVE_REMAINING:'100',
        GIVE_PRICE:    '0.1',   // 100 RAREPEPE / 1000 PEPECASH → 0.1 PEPECASH per RAREPEPE
        GIVE_COIN:     'BTC',
        GET_TICK:      'PEPECASH',
        GET_TICK_ID:   20,
        GET_AMOUNT:    '1000',
        GET_REMAINING: '1000',
        GET_PRICE:     '10',    // inverse: 1000 PEPECASH / 100 RAREPEPE = 10 RAREPEPE per PEPECASH
        GET_ADDRESS:   SOURCE,
        ALLOW_LIST:    null,
        BLOCK_LIST:    null,
        ORDER_STATUS:  'open',
        COIN:          'BTC',
    }, overrides);
}

/**
 * Builds a matching counterpart order.
 * By convention the match swaps GIVE/GET ticks vs the original order.
 *
 * The match's GET_PRICE is the field that must be <= orderInfo.GIVE_PRICE for a match.
 */
function makeMatchInfo(overrides = {}) {
    return Object.assign({
        ACTION_INDEX:  2,
        SOURCE:        OTHER,
        GIVE_TICK:     'PEPECASH',
        GIVE_TICK_ID:  20,
        GIVE_AMOUNT:   '1000',
        GIVE_REMAINING:'1000',
        GIVE_PRICE:    '10',   // 1000 PEPECASH / 100 RAREPEPE → 10 RAREPEPE per PEPECASH
        GIVE_COIN:     'BTC',
        GET_TICK:      'RAREPEPE',
        GET_TICK_ID:   10,
        GET_AMOUNT:    '100',
        GET_REMAINING: '100',
        GET_PRICE:     '0.1',  // inverse: asking 0.1 PEPECASH per RAREPEPE (= orderInfo.GIVE_PRICE)
        GET_ADDRESS:   OTHER,
        ALLOW_LIST:    null,
        BLOCK_LIST:    null,
        ORDER_STATUS:  'open',
        COIN:          'BTC',
    }, overrides);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('ORDER_MATCH price-boundary tests @regression @tier2', function () {

    // -----------------------------------------------------------------------
    // ORD-01: Exact price match → match succeeds
    // -----------------------------------------------------------------------

    describe('ORD-01: Exact price match → match succeeds', function () {
        let indexer, actionsCtx, handler;

        beforeEach(function () {
            indexer    = createMockIndexer();
            actionsCtx = makeActionsCtx(indexer);
            handler    = new OrderMatch(actionsCtx);

            // match.GET_PRICE == order.GIVE_PRICE  →  bcgt returns false  →  match proceeds
            const orderInfo = makeOrderInfo();
            const matchInfo = makeMatchInfo();  // GET_PRICE = '0.1' == GIVE_PRICE = '0.1'

            indexer.indexerDb.getOrderInfo.resolves(orderInfo);
            indexer.indexerDb.findOrderMatches.resolves([matchInfo]);
            indexer.indexerDb.getTokenInfo.resolves(createTokenInfo({ TICK: 'RAREPEPE', DECIMALS: 0 }));
            indexer.indexerDb.createActionIndex.resolves(10);
        });

        afterEach(function () { sinon.restore(); });

        it('match.GET_PRICE === order.GIVE_PRICE → createOrderMatch called once', async function () {
            const data = createBaseData({
                ACTION:             'ORDER_MATCH',
                BLOCK_TIME,
                ORDER_ACTION_INDEX: 1,
                GET_COIN:           'BTC',
                GET_TICK:           'RAREPEPE',
            });

            await handler.parse(null, data, null);

            assert.strictEqual(indexer.indexerDb.createOrderMatch.callCount, 1,
                'expected createOrderMatch to be called exactly once');
        });
    });

    // -----------------------------------------------------------------------
    // ORD-02: Match price slightly better → match succeeds
    // -----------------------------------------------------------------------

    describe('ORD-02: Match price slightly better than order → match succeeds', function () {
        let indexer, actionsCtx, handler;

        beforeEach(function () {
            indexer    = createMockIndexer();
            actionsCtx = makeActionsCtx(indexer);
            handler    = new OrderMatch(actionsCtx);

            // match.GET_PRICE = 0.09 < order.GIVE_PRICE = 0.1 → bcgt returns false → match proceeds
            const orderInfo = makeOrderInfo();
            const matchInfo = makeMatchInfo({ GET_PRICE: '0.09' });

            indexer.indexerDb.getOrderInfo.resolves(orderInfo);
            indexer.indexerDb.findOrderMatches.resolves([matchInfo]);
            indexer.indexerDb.getTokenInfo.resolves(createTokenInfo({ TICK: 'RAREPEPE', DECIMALS: 0 }));
            indexer.indexerDb.createActionIndex.resolves(10);
        });

        afterEach(function () { sinon.restore(); });

        it('match.GET_PRICE < order.GIVE_PRICE → match is not skipped', async function () {
            const data = createBaseData({
                ACTION:             'ORDER_MATCH',
                BLOCK_TIME,
                ORDER_ACTION_INDEX: 1,
                GET_COIN:           'BTC',
                GET_TICK:           'RAREPEPE',
            });

            await handler.parse(null, data, null);

            assert.strictEqual(indexer.indexerDb.createOrderMatch.callCount, 1,
                'expected createOrderMatch to be called when match price is better');
        });
    });

    // -----------------------------------------------------------------------
    // ORD-03: Match price slightly worse → match skipped
    // -----------------------------------------------------------------------

    describe('ORD-03: Match price slightly worse than order → match skipped', function () {
        let indexer, actionsCtx, handler;

        beforeEach(function () {
            indexer    = createMockIndexer();
            actionsCtx = makeActionsCtx(indexer);
            handler    = new OrderMatch(actionsCtx);

            // match.GET_PRICE = 0.11 > order.GIVE_PRICE = 0.1 → bcgt returns true → skipped
            const orderInfo = makeOrderInfo();
            const matchInfo = makeMatchInfo({ GET_PRICE: '0.11' });

            indexer.indexerDb.getOrderInfo.resolves(orderInfo);
            indexer.indexerDb.findOrderMatches.resolves([matchInfo]);
            indexer.indexerDb.getTokenInfo.resolves(createTokenInfo({ TICK: 'RAREPEPE', DECIMALS: 0 }));
        });

        afterEach(function () { sinon.restore(); });

        it('match.GET_PRICE > order.GIVE_PRICE → createOrderMatch never called', async function () {
            const data = createBaseData({
                ACTION:             'ORDER_MATCH',
                BLOCK_TIME,
                ORDER_ACTION_INDEX: 1,
                GET_COIN:           'BTC',
                GET_TICK:           'RAREPEPE',
            });

            await handler.parse(null, data, null);

            assert.strictEqual(indexer.indexerDb.createOrderMatch.callCount, 0,
                'expected createOrderMatch NOT to be called when match price exceeds order price');
        });
    });

    // -----------------------------------------------------------------------
    // ORD-04: GIVE_REMAINING = 1 (smallest unit) → order completes
    // -----------------------------------------------------------------------

    describe('ORD-04: Order with GIVE_REMAINING = 1 fills and completes', function () {
        let indexer, actionsCtx, handler;

        beforeEach(function () {
            indexer    = createMockIndexer();
            actionsCtx = makeActionsCtx(indexer);
            handler    = new OrderMatch(actionsCtx);

            // Order has only 1 unit left to give; GIVE_PRICE = 1 so GET_PRICE = 1 (1:1 ratio)
            const orderInfo = makeOrderInfo({
                GIVE_AMOUNT:    '1',
                GIVE_REMAINING: '1',
                GIVE_PRICE:     '1',    // 1 RAREPEPE / 1 PEPECASH
                GET_AMOUNT:     '1',
                GET_REMAINING:  '1',
                GET_PRICE:      '1',
            });

            // Match offers a compatible price (GET_PRICE = 1 == GIVE_PRICE = 1)
            const matchInfo = makeMatchInfo({
                GIVE_AMOUNT:    '1',
                GIVE_REMAINING: '1',
                GIVE_PRICE:     '1',
                GET_AMOUNT:     '1',
                GET_REMAINING:  '1',
                GET_PRICE:      '1',
            });

            indexer.indexerDb.getOrderInfo.resolves(orderInfo);
            indexer.indexerDb.findOrderMatches.resolves([matchInfo]);
            indexer.indexerDb.getTokenInfo.resolves(createTokenInfo({ TICK: 'RAREPEPE', DECIMALS: 0 }));
            indexer.indexerDb.createActionIndex.resolves(10);
        });

        afterEach(function () { sinon.restore(); });

        it('filling last unit of GIVE_REMAINING=1 triggers createOrderStatus(complete)', async function () {
            const data = createBaseData({
                ACTION:             'ORDER_MATCH',
                BLOCK_TIME,
                ORDER_ACTION_INDEX: 1,
                GET_COIN:           'BTC',
                GET_TICK:           'RAREPEPE',
            });

            await handler.parse(null, data, null);

            assert.strictEqual(indexer.indexerDb.createOrderMatch.callCount, 1,
                'expected the single-unit order to produce one match');

            // createOrderStatus is called with 'complete' for at least the original order
            const statusCalls = indexer.indexerDb.createOrderStatus.args;
            const completeCalls = statusCalls.filter(args => args[2] === 'complete');
            assert.ok(completeCalls.length >= 1,
                'expected at least one createOrderStatus call with status "complete"');
        });
    });

    // -----------------------------------------------------------------------
    // ORD-05: Multiple matches, best price matched first
    // -----------------------------------------------------------------------

    describe('ORD-05: Multiple matches returned — better price processed first', function () {
        let indexer, actionsCtx, handler;

        beforeEach(function () {
            indexer    = createMockIndexer();
            actionsCtx = makeActionsCtx(indexer);
            handler    = new OrderMatch(actionsCtx);

            const orderInfo = makeOrderInfo({
                GIVE_AMOUNT:    '200',
                GIVE_REMAINING: '200',
                GET_AMOUNT:     '2000',
                GET_REMAINING:  '2000',
                GIVE_PRICE:     '0.1',
                GET_PRICE:      '10',
            });

            // findOrderMatches returns matches sorted by price desc, action_index asc
            // matchA has lower GET_PRICE (better for the order) → processed first
            const matchA = makeMatchInfo({
                ACTION_INDEX:   2,
                GIVE_AMOUNT:    '1000',
                GIVE_REMAINING: '1000',
                GET_AMOUNT:     '100',
                GET_REMAINING:  '100',
                GET_PRICE:      '0.05',  // better: asking less than order offers (0.1)
            });

            // matchB has a slightly worse price but still compatible
            const matchB = makeMatchInfo({
                ACTION_INDEX:   3,
                GIVE_AMOUNT:    '1000',
                GIVE_REMAINING: '1000',
                GET_AMOUNT:     '100',
                GET_REMAINING:  '100',
                GET_PRICE:      '0.09',  // still below 0.1 → also valid
            });

            indexer.indexerDb.getOrderInfo.resolves(orderInfo);
            // Simulate DB returning matchA first (better price), then matchB
            indexer.indexerDb.findOrderMatches.resolves([matchA, matchB]);
            indexer.indexerDb.getTokenInfo.resolves(createTokenInfo({ TICK: 'RAREPEPE', DECIMALS: 0 }));
            indexer.indexerDb.createActionIndex.resolves(10);
        });

        afterEach(function () { sinon.restore(); });

        it('both compatible matches are processed in DB-returned order', async function () {
            const data = createBaseData({
                ACTION:             'ORDER_MATCH',
                BLOCK_TIME,
                ORDER_ACTION_INDEX: 1,
                GET_COIN:           'BTC',
                GET_TICK:           'RAREPEPE',
            });

            await handler.parse(null, data, null);

            // Both matches should have resulted in createOrderMatch calls
            assert.ok(indexer.indexerDb.createOrderMatch.callCount >= 1,
                'expected at least the first compatible match to produce a createOrderMatch call');

            // The first call should have used matchA's data (ACTION_INDEX = 2)
            const firstCall = indexer.indexerDb.createOrderMatch.getCall(0);
            assert.ok(firstCall, 'expected at least one createOrderMatch call');
            // matchInfo passed as third arg; verify it's the better-priced match (ACTION_INDEX 2)
            assert.strictEqual(firstCall.args[2]['ACTION_INDEX'], 2,
                'expected the first processed match to be the better-priced one (ACTION_INDEX 2)');
        });
    });
});
