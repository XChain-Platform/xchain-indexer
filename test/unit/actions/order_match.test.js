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
// Order_Match action handler: the no-order and price gates and the reciprocity
// check. The fill, skip and allow/block list, native coin, ownership, debug
// mode, token list and escrow precision cases live beside it in
// order_match.test/, the handler cases each opening the same 'Order_Match
// action handler @regression @tier2' describe so every full test title is
// unchanged; order_match.test/helpers/order_match_harness.js holds the order
// fixtures and the mock harness they share.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const sinon  = require('sinon');
const { createBaseData, createTokenInfo } = require('../../fixtures/mocks');
const {
    BLOCK_TIME, makeOrderInfo, makeMatchInfo, useOrderMatchHarness,
} = require('./order_match.test/helpers/order_match_harness.js');

// Each test gets a fresh harness from useOrderMatchHarness; bind() hands it to
// the names the test bodies use.
let indexer, orderMatch;
const bind = (h) => { ({ indexer, orderMatch } = h); };

// ─── Test suite ───────────────────────────────────────────────────────────────

// ─── No matching order ────────────────────────────────────────────────

describe('Order_Match action handler @regression @tier2', function () {
    useOrderMatchHarness(bind);

    it('returns early when orderInfo is null (order not found)', async function () {
        indexer.indexerDb.getOrderInfo.resolves(null);

        const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME, ACTION_INDEX: 1 });
        await orderMatch.parse([], data, false);

        sinon.assert.notCalled(indexer.indexerDb.findOrderMatches);
        sinon.assert.notCalled(indexer.indexerDb.createOrderMatch);
    });

    it('no matches found, createOrderMatch is never called', async function () {
        indexer.indexerDb.getOrderInfo.resolves(makeOrderInfo());
        indexer.indexerDb.findOrderMatches.resolves([]);

        const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME, ACTION_INDEX: 1 });
        await orderMatch.parse([], data, false);

        sinon.assert.calledOnce(indexer.indexerDb.findOrderMatches);
        sinon.assert.notCalled(indexer.indexerDb.createOrderMatch);
    });

    // ─── Price validation ────────────────────────────────────────────────

    it('skips match when matchInfo.GET_PRICE > orderInfo.GIVE_PRICE', async function () {
        // GIVE_PRICE=5, but match wants GET_PRICE=10 : mismatch → skip
        indexer.indexerDb.getOrderInfo.resolves(makeOrderInfo({ GIVE_PRICE: '5', GET_PRICE: '0.2' }));
        indexer.indexerDb.findOrderMatches.resolves([makeMatchInfo({ GET_PRICE: '10' })]);

        const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME, ACTION_INDEX: 1 });
        await orderMatch.parse([], data, false);

        sinon.assert.notCalled(indexer.indexerDb.createOrderMatch);
    });

    it('processes match when matchInfo.GET_PRICE <= orderInfo.GIVE_PRICE (exact)', async function () {
        // Both prices equal (10 == 10) → match proceeds
        indexer.indexerDb.getOrderInfo.resolves(makeOrderInfo({ GIVE_PRICE: '10', GET_PRICE: '0.1' }));
        indexer.indexerDb.findOrderMatches.resolves([makeMatchInfo({ GET_PRICE: '10' })]);

        const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME, ACTION_INDEX: 1 });
        await orderMatch.parse([], data, false);

        sinon.assert.calledOnce(indexer.indexerDb.createOrderMatch);
    });

    it('processes match when matchInfo.GET_PRICE < orderInfo.GIVE_PRICE (better price)', async function () {
        // Match asks for less than order offers → better deal for the maker
        indexer.indexerDb.getOrderInfo.resolves(makeOrderInfo({ GIVE_PRICE: '15', GET_PRICE: '0.1' }));
        indexer.indexerDb.findOrderMatches.resolves([makeMatchInfo({ GET_PRICE: '10' })]);

        const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME, ACTION_INDEX: 1 });
        await orderMatch.parse([], data, false);

        sinon.assert.calledOnce(indexer.indexerDb.createOrderMatch);
    });
});

// Reciprocity gate. The order wants PEPECASH; a candidate whose GIVE side is a DIFFERENT
// token (reverse-leg mismatch that the incomplete findOrderMatches predicate would return) must
// be skipped, not settled - otherwise the taker is credited a token the maker never escrowed
// (an unbounded mint out of the global escrow pool).
describe('Order_Match action handler @regression @tier2', function () {
    useOrderMatchHarness(bind);

    it('skips a non-reciprocal match whose GIVE token != the order GET token (OM-1)', async function () {
        indexer.indexerDb.getTokenInfo
            .withArgs('SCAMTOKEN', sinon.match.any, sinon.match.any)
            .resolves(createTokenInfo({ TICK: 'SCAMTOKEN', TICK_ID: 30, ALLOW_LIST: null, BLOCK_LIST: null }));

        // orderInfo: GIVE RAREPEPE, GET PEPECASH. Candidate: GET RAREPEPE (forward leg holds) but
        // GIVE SCAMTOKEN (reverse leg violated: order.GET PEPECASH != match.GIVE SCAMTOKEN).
        indexer.indexerDb.getOrderInfo.resolves(makeOrderInfo({ GIVE_PRICE: '10', GET_PRICE: '0.1' }));
        indexer.indexerDb.findOrderMatches.resolves([makeMatchInfo({ GIVE_TICK: 'SCAMTOKEN', GET_PRICE: '10' })]);

        const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME, ACTION_INDEX: 1 });
        await orderMatch.parse([], data, false);

        sinon.assert.notCalled(indexer.indexerDb.createOrderMatch);
        sinon.assert.notCalled(indexer.indexerDb.createCredit);
    });

    it('skips a non-reciprocal match whose GIVE coin != the order GET coin (OM-1 cross-chain)', async function () {
        // Forward + reverse ticks mirror, but the match GIVES on a different coin than the order GETS.
        indexer.indexerDb.getOrderInfo.resolves(makeOrderInfo({ GIVE_PRICE: '10', GET_PRICE: '0.1' }));
        indexer.indexerDb.findOrderMatches.resolves([makeMatchInfo({ GIVE_COIN: 'LTC', GET_PRICE: '10' })]);

        const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME, ACTION_INDEX: 1 });
        await orderMatch.parse([], data, false);

        sinon.assert.notCalled(indexer.indexerDb.createOrderMatch);
    });
});
