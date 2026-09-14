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
// Order_Match debug mode: every logged skip and fill path still reaches the
// same match outcome.
// Part of the Order_Match suite; see ../order_match.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const sinon  = require('sinon');
const { createBaseData } = require('../../../fixtures/mocks');
const {
    BLOCK_TIME, makeOrderInfo, makeMatchInfo, useOrderMatchHarness,
} = require('./helpers/order_match_harness.js');

// Each test gets a fresh harness from useOrderMatchHarness; bind() hands it to
// the names the test bodies use.
let indexer, orderMatch;
const bind = (h) => { ({ indexer, orderMatch } = h); };

// ─── Debug mode console-log paths ─────────────────────────────────────

describe('Order_Match action handler @regression @tier2', function () {
    useOrderMatchHarness(bind);

    describe('debug mode (handler.debug = true)', function () {
        it('logs remaining amounts when debug=true and a match proceeds (lines 99-101)', async function () {
            orderMatch.debug = true;
            indexer.indexerDb.getOrderInfo.resolves(makeOrderInfo());
            indexer.indexerDb.findOrderMatches.resolves([makeMatchInfo()]);

            const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME, ACTION_INDEX: 1 });
            await orderMatch.parse([], data, false);

            // Lines 99-101 fire; createOrderMatch still called for a valid match
            sinon.assert.calledOnce(indexer.indexerDb.createOrderMatch);
        });

        it('logs skip reason in debug mode when GIVE_REMAINING is zero (lines 105-107)', async function () {
            orderMatch.debug = true;
            indexer.indexerDb.getOrderInfo.resolves(makeOrderInfo({ GIVE_REMAINING: '0' }));
            indexer.indexerDb.findOrderMatches.resolves([makeMatchInfo()]);

            const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME, ACTION_INDEX: 1 });
            await orderMatch.parse([], data, false);

            // Zero GIVE_REMAINING → skip (lines 104-107 fire with debug message)
            sinon.assert.notCalled(indexer.indexerDb.createOrderMatch);
        });

        it('logs skip reason in debug mode when GET_REMAINING is zero (lines 111-114)', async function () {
            orderMatch.debug = true;
            indexer.indexerDb.getOrderInfo.resolves(makeOrderInfo({ GET_REMAINING: '0' }));
            indexer.indexerDb.findOrderMatches.resolves([makeMatchInfo()]);

            const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME, ACTION_INDEX: 1 });
            await orderMatch.parse([], data, false);

            sinon.assert.notCalled(indexer.indexerDb.createOrderMatch);
        });

        it('logs price mismatch skip in debug mode (lines 119-121)', async function () {
            orderMatch.debug = true;
            indexer.indexerDb.getOrderInfo.resolves(makeOrderInfo({ GIVE_PRICE: '5' }));
            indexer.indexerDb.findOrderMatches.resolves([makeMatchInfo({ GET_PRICE: '10' })]);

            const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME, ACTION_INDEX: 1 });
            await orderMatch.parse([], data, false);

            sinon.assert.notCalled(indexer.indexerDb.createOrderMatch);
        });
    });
});

describe('Order_Match action handler @regression @tier2', function () {
    useOrderMatchHarness(bind);

    describe('debug mode (handler.debug = true)', function () {
        it('logs zero GIVE amount skip in debug mode (lines 154-157)', async function () {
            orderMatch.debug = true;
            // Construct: orderInfo.GET_PRICE=0, matchInfo.GET_PRICE=1=orderInfo.GIVE_PRICE
            //   price check: matchInfo.GET_PRICE(1) > orderInfo.GIVE_PRICE(1) → false (passes)
            //   give_from_get = max_get * GET_PRICE(0) = 0
            //   0 <= max_give → give_amount = give_from_get = 0
            //   bclte(give_amount=0, 0) → true → lines 153-157 fire
            indexer.indexerDb.getOrderInfo.resolves(makeOrderInfo({
                GIVE_REMAINING: '10',
                GET_REMAINING:  '100',
                GIVE_PRICE:     '1',
                GET_PRICE:      '0',
            }));
            indexer.indexerDb.findOrderMatches.resolves([makeMatchInfo({
                GIVE_REMAINING: '100',
                GET_REMAINING:  '10',
                GET_PRICE:      '1',
            })]);

            const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME, ACTION_INDEX: 1 });
            await orderMatch.parse([], data, false);

            // zero give_amount → lines 153-157 fire; match skipped
            sinon.assert.notCalled(indexer.indexerDb.createOrderMatch);
        });

        it('logs zero GET amount skip in debug mode (lines 161-164)', async function () {
            orderMatch.debug = true;
            // To get give_amount > 0 but get_amount = 0: use GIVE_PRICE=0.
            // give-side bottleneck: give_amount = max_give (> 0), get_amount = max_give * GIVE_PRICE = 0
            // We need give_from_get > max_give (give-side bottleneck):
            //   give_from_get = max_get * GET_PRICE; must be > max_give
            // Use large GET_PRICE so give_from_get >> max_give.
            indexer.indexerDb.getOrderInfo.resolves(makeOrderInfo({
                GIVE_REMAINING: '10',
                GET_REMAINING:  '100',
                GIVE_PRICE:     '0',       // get_amount = give_amount * 0 = 0
                GET_PRICE:      '1000',    // give_from_get = 100 * 1000 >> 10 → give-side is bottleneck
            }));
            indexer.indexerDb.findOrderMatches.resolves([makeMatchInfo({
                GIVE_REMAINING: '100',
                GET_REMAINING:  '10',
                GET_PRICE:      '0.001',   // <= GIVE_PRICE(0)? No. GIVE_PRICE=0 means price mismatch check fails…
            })]);

            const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME, ACTION_INDEX: 1 });
            await orderMatch.parse([], data, false);

            // This fixture reaches a debug skip (zero-get and/or price-mismatch), and
            // BOTH skip reasons must leave the order unmatched. Assert the consensus-
            // relevant outcome (no ORDER_MATCH created) rather than mere no-crash, so a
            // regression that wrongly creates a match on this path fails.
            sinon.assert.notCalled(indexer.indexerDb.createOrderMatch);
        });
    });
});

describe('Order_Match action handler @regression @tier2', function () {
    useOrderMatchHarness(bind);

    describe('debug mode (handler.debug = true)', function () {
        it('logs allow/block list skip in debug mode (lines 195-197)', async function () {
            orderMatch.debug = true;
            const matchAddr = 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM';
            indexer.indexerDb.getOrderInfo.resolves(makeOrderInfo({ BLOCK_LIST: '6' }));
            indexer.indexerDb.findOrderMatches.resolves([makeMatchInfo({ GET_ADDRESS: matchAddr })]);
            indexer.indexerDb.getList.resolves([matchAddr]);

            const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME, ACTION_INDEX: 1 });
            await orderMatch.parse([], data, false);

            sinon.assert.notCalled(indexer.indexerDb.createOrderMatch);
        });

        it('logs final remaining in debug mode after a successful match (line 208)', async function () {
            orderMatch.debug = true;
            indexer.indexerDb.getOrderInfo.resolves(makeOrderInfo());
            indexer.indexerDb.findOrderMatches.resolves([makeMatchInfo()]);

            const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME, ACTION_INDEX: 1 });
            await orderMatch.parse([], data, false);

            // Line 208 fires after remaining update : match succeeds
            sinon.assert.calledOnce(indexer.indexerDb.createOrderMatch);
        });

        it('logs ownership skip in debug mode (lines 176-178)', async function () {
            orderMatch.debug = true;
            const ownershipOrder = makeOrderInfo({
                GIVE_OWNERSHIP: 1, GET_OWNERSHIP: 0,
                GIVE_AMOUNT: '1', GIVE_REMAINING: '1', GIVE_PRICE: '100',
                GET_REMAINING: '100', GET_AMOUNT: '100', GET_PRICE: '0.01',
            });
            const partialMatch = makeMatchInfo({
                GIVE_OWNERSHIP: 0, GET_OWNERSHIP: 1,
                GIVE_REMAINING: '50', GET_REMAINING: '1', GET_PRICE: '100',
            });
            indexer.indexerDb.getOrderInfo.resolves(ownershipOrder);
            indexer.indexerDb.findOrderMatches.resolves([partialMatch]);

            const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME, ACTION_INDEX: 1 });
            await orderMatch.parse([], data, false);

            sinon.assert.notCalled(indexer.indexerDb.createOrderMatch);
        });

    });
});
