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
// Order_Match ownership orders: token ownership transfer on either give side
// and single-fill enforcement.
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

// ─── Ownership order matching ─────────────────────────────────────────

describe('Order_Match action handler @regression @tier2', function () {
    useOrderMatchHarness(bind);

    it('GIVE_OWNERSHIP=1 on orderInfo calls transferTokenOwnership for the give side', async function () {
        const transferSpy = sinon.stub(indexer.util, 'transferTokenOwnership').resolves();

        // Compatibility filter: match.GIVE_OWNERSHIP must == orderInfo.GET_OWNERSHIP (0)
        //                       match.GET_OWNERSHIP  must == orderInfo.GIVE_OWNERSHIP (1)
        const ownershipOrder = makeOrderInfo({
            GIVE_OWNERSHIP: 1,
            GET_OWNERSHIP:  0,
            GIVE_TICK:      'RAREPEPE',
            GIVE_AMOUNT:    '1',
            GIVE_REMAINING: '1',
            GIVE_PRICE:     '100',
            GET_TICK:       'PEPECASH',
            GET_AMOUNT:     '100',
            GET_REMAINING:  '100',
            GET_PRICE:      '0.01',
        });
        const counterMatch = makeMatchInfo({
            GIVE_OWNERSHIP: 0,  // must equal orderInfo.GET_OWNERSHIP
            GET_OWNERSHIP:  1,  // must equal orderInfo.GIVE_OWNERSHIP
            GIVE_TICK:      'PEPECASH',
            GIVE_AMOUNT:    '100',
            GIVE_REMAINING: '100',
            GET_TICK:       'RAREPEPE',
            GET_AMOUNT:     '1',
            GET_REMAINING:  '1',
            GET_PRICE:      '100',
        });

        indexer.indexerDb.getOrderInfo.resolves(ownershipOrder);
        indexer.indexerDb.findOrderMatches.resolves([counterMatch]);

        const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME, ACTION_INDEX: 1 });
        await orderMatch.parse([], data, false);

        sinon.assert.called(transferSpy);
    });
});

describe('Order_Match action handler @regression @tier2', function () {
    useOrderMatchHarness(bind);

    it('GIVE_OWNERSHIP=1 on matchInfo calls transferTokenOwnership for the match give side', async function () {
        const transferSpy = sinon.stub(indexer.util, 'transferTokenOwnership').resolves();

        // Compatibility filter: match.GIVE_OWNERSHIP must == orderInfo.GET_OWNERSHIP (1)
        //                       match.GET_OWNERSHIP  must == orderInfo.GIVE_OWNERSHIP (0)
        const regularOrder = makeOrderInfo({
            GIVE_OWNERSHIP: 0,
            GET_OWNERSHIP:  1,
            GIVE_TICK:      'PEPECASH',
            GIVE_AMOUNT:    '100',
            GIVE_REMAINING: '100',
            GIVE_PRICE:     '0.01',
            GET_TICK:       'RAREPEPE',
            GET_AMOUNT:     '1',
            GET_REMAINING:  '1',
            GET_PRICE:      '100',
        });
        const ownershipMatch = makeMatchInfo({
            GIVE_OWNERSHIP: 1,  // must equal orderInfo.GET_OWNERSHIP
            GET_OWNERSHIP:  0,  // must equal orderInfo.GIVE_OWNERSHIP
            GIVE_TICK:      'RAREPEPE',
            GIVE_AMOUNT:    '1',
            GIVE_REMAINING: '1',
            GET_TICK:       'PEPECASH',
            GET_AMOUNT:     '100',
            GET_REMAINING:  '100',
            GET_PRICE:      '0.01',
        });

        indexer.indexerDb.getOrderInfo.resolves(regularOrder);
        indexer.indexerDb.findOrderMatches.resolves([ownershipMatch]);

        const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME, ACTION_INDEX: 1 });
        await orderMatch.parse([], data, false);

        sinon.assert.called(transferSpy);
    });
});

// ─── Ownership single-fill enforcement ────────────────────────────────

describe('Order_Match action handler @regression @tier2', function () {
    useOrderMatchHarness(bind);

    it('ownership order: skipped when amounts are not exactly equal (single-fill enforcement)', async function () {
        // orderInfo has GIVE_OWNERSHIP=1, GIVE_REMAINING=1, GET_REMAINING=100
        // match offers only 50 PEPECASH (half of expected 100) → rejected
        const ownershipOrder = makeOrderInfo({
            GIVE_OWNERSHIP: 1,
            GET_OWNERSHIP:  0,
            GIVE_AMOUNT:    '1',
            GIVE_REMAINING: '1',
            GIVE_PRICE:     '100',
            GET_REMAINING:  '100',
            GET_AMOUNT:     '100',
            GET_PRICE:      '0.01',
        });
        const partialMatch = makeMatchInfo({
            GIVE_OWNERSHIP: 0,
            GET_OWNERSHIP:  1,
            GIVE_TICK:      'PEPECASH',
            GIVE_REMAINING: '50',   // only half the required 100
            GET_TICK:       'RAREPEPE',
            GET_REMAINING:  '1',
            GET_PRICE:      '100',
        });

        indexer.indexerDb.getOrderInfo.resolves(ownershipOrder);
        indexer.indexerDb.findOrderMatches.resolves([partialMatch]);

        const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME, ACTION_INDEX: 1 });
        await orderMatch.parse([], data, false);

        // Single-fill enforcement : must skip partial matches for ownership orders
        sinon.assert.notCalled(indexer.indexerDb.createOrderMatch);
    });
});
