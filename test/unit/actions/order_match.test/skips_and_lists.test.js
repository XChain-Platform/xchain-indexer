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
// Order_Match skips on a zero remaining, the order and match allow/block
// lists, the ledger writes after a match, the ORDER_ACTION_INDEX fallback and the
// ownership compatibility filter.
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

// ─── Skips with zero remaining ────────────────────────────────────────

describe('Order_Match action handler @regression @tier2', function () {
    useOrderMatchHarness(bind);

    it('skips match when match GIVE_REMAINING is zero', async function () {
        indexer.indexerDb.getOrderInfo.resolves(makeOrderInfo());
        indexer.indexerDb.findOrderMatches.resolves([makeMatchInfo({ GIVE_REMAINING: '0' })]);

        const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME, ACTION_INDEX: 1 });
        await orderMatch.parse([], data, false);

        sinon.assert.notCalled(indexer.indexerDb.createOrderMatch);
    });

    it('skips match when match GET_REMAINING is zero', async function () {
        indexer.indexerDb.getOrderInfo.resolves(makeOrderInfo());
        indexer.indexerDb.findOrderMatches.resolves([makeMatchInfo({ GET_REMAINING: '0' })]);

        const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME, ACTION_INDEX: 1 });
        await orderMatch.parse([], data, false);

        sinon.assert.notCalled(indexer.indexerDb.createOrderMatch);
    });

    it('skips match when order GIVE_REMAINING is zero', async function () {
        indexer.indexerDb.getOrderInfo.resolves(makeOrderInfo({ GIVE_REMAINING: '0' }));
        indexer.indexerDb.findOrderMatches.resolves([makeMatchInfo()]);

        const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME, ACTION_INDEX: 1 });
        await orderMatch.parse([], data, false);

        sinon.assert.notCalled(indexer.indexerDb.createOrderMatch);
    });

    // ─── Allow/block list cross-check ────────────────────────────────────

    it('skips match when orderInfo ALLOW_LIST does not include match GET_ADDRESS', async function () {
        indexer.indexerDb.getOrderInfo.resolves(makeOrderInfo({ ALLOW_LIST: '5' }));
        indexer.indexerDb.findOrderMatches.resolves([makeMatchInfo()]);
        // getList for ALLOW_LIST returns list that excludes match GET_ADDRESS
        indexer.indexerDb.getList.resolves(['1SomeOtherAddressXXXXXXXXXXXXXXXXXX']);

        const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME, ACTION_INDEX: 1 });
        await orderMatch.parse([], data, false);

        sinon.assert.notCalled(indexer.indexerDb.createOrderMatch);
    });

    it('skips match when orderInfo BLOCK_LIST includes match GET_ADDRESS', async function () {
        const matchAddr = 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM';
        indexer.indexerDb.getOrderInfo.resolves(makeOrderInfo({ BLOCK_LIST: '6' }));
        indexer.indexerDb.findOrderMatches.resolves([makeMatchInfo({ GET_ADDRESS: matchAddr })]);
        // BLOCK_LIST includes the match GET_ADDRESS
        indexer.indexerDb.getList.resolves([matchAddr]);

        const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME, ACTION_INDEX: 1 });
        await orderMatch.parse([], data, false);

        sinon.assert.notCalled(indexer.indexerDb.createOrderMatch);
    });
});

describe('Order_Match action handler @regression @tier2', function () {
    useOrderMatchHarness(bind);

    it('skips match when matchInfo ALLOW_LIST does not include order GET_ADDRESS', async function () {
        indexer.indexerDb.getOrderInfo.resolves(makeOrderInfo());
        indexer.indexerDb.findOrderMatches.resolves([makeMatchInfo({ ALLOW_LIST: '7' })]);
        // ALLOW_LIST excludes order GET_ADDRESS
        indexer.indexerDb.getList.resolves(['1SomeOtherAddressXXXXXXXXXXXXXXXXXX']);

        const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME, ACTION_INDEX: 1 });
        await orderMatch.parse([], data, false);

        sinon.assert.notCalled(indexer.indexerDb.createOrderMatch);
    });

    it('processes match when both allow lists include the respective GET_ADDRESSes', async function () {
        const orderAddr = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
        const matchAddr = 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM';

        indexer.indexerDb.getOrderInfo.resolves(makeOrderInfo({
            ALLOW_LIST:  '5',
            GET_ADDRESS: orderAddr,
            GIVE_PRICE:  '10',
            GET_PRICE:   '0.1',
        }));
        indexer.indexerDb.findOrderMatches.resolves([makeMatchInfo({
            ALLOW_LIST:  null,
            GET_ADDRESS: matchAddr,
            GET_PRICE:   '10',
        })]);

        // ALLOW_LIST for orderInfo includes both addresses → both sides permitted
        indexer.indexerDb.getList.resolves([orderAddr, matchAddr]);

        const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME, ACTION_INDEX: 1 });
        await orderMatch.parse([], data, false);

        sinon.assert.calledOnce(indexer.indexerDb.createOrderMatch);
    });

    // ─── Ledger changes ───────────────────────────────────────────────────

    it('updates balances after a successful match', async function () {
        indexer.indexerDb.getOrderInfo.resolves(makeOrderInfo());
        indexer.indexerDb.findOrderMatches.resolves([makeMatchInfo()]);

        const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME, ACTION_INDEX: 1 });
        await orderMatch.parse([], data, false);

        sinon.assert.called(indexer.indexerDb.updateBalances);
    });
});

describe('Order_Match action handler @regression @tier2', function () {
    useOrderMatchHarness(bind);

    it('creates action mappings after a successful match', async function () {
        indexer.indexerDb.getOrderInfo.resolves(makeOrderInfo());
        indexer.indexerDb.findOrderMatches.resolves([makeMatchInfo()]);

        const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME, ACTION_INDEX: 1 });
        await orderMatch.parse([], data, false);

        sinon.assert.called(indexer.mapper.createMappings);
    });

    // ─── ORDER_ACTION_INDEX fallback ──────────────────────────────────────

    it('uses ORDER_ACTION_INDEX from data when present', async function () {
        indexer.indexerDb.getOrderInfo.resolves(makeOrderInfo({ ACTION_INDEX: 77 }));
        indexer.indexerDb.findOrderMatches.resolves([]);

        const data = createBaseData({
            ACTION:             'ORDER_MATCH',
            BLOCK_TIME,
            ACTION_INDEX:       1,
            ORDER_ACTION_INDEX: 77,
        });
        await orderMatch.parse([], data, false);

        sinon.assert.calledWith(indexer.indexerDb.getOrderInfo, 'BTC', 77);
    });

    it('falls back to ACTION_INDEX when ORDER_ACTION_INDEX is absent', async function () {
        indexer.indexerDb.getOrderInfo.resolves(makeOrderInfo({ ACTION_INDEX: 1 }));
        indexer.indexerDb.findOrderMatches.resolves([]);

        const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME, ACTION_INDEX: 1 });
        await orderMatch.parse([], data, false);

        sinon.assert.calledWith(indexer.indexerDb.getOrderInfo, 'BTC', 1);
    });

    // ─── Ownership compatibility filter ───────────────────────────────────

    it('filters out matches where GIVE_OWNERSHIP does not mirror GET_OWNERSHIP', async function () {
        // orderInfo has GIVE_OWNERSHIP=0, GET_OWNERSHIP=0
        // matchInfo has GIVE_OWNERSHIP=1, GET_OWNERSHIP=0 → ownership mismatch → filtered out
        indexer.indexerDb.getOrderInfo.resolves(makeOrderInfo({ GIVE_OWNERSHIP: 0, GET_OWNERSHIP: 0 }));
        indexer.indexerDb.findOrderMatches.resolves([makeMatchInfo({ GIVE_OWNERSHIP: 1, GET_OWNERSHIP: 0 })]);

        const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME, ACTION_INDEX: 1 });
        await orderMatch.parse([], data, false);

        // After filtering, matches becomes empty → createOrderMatch not called
        sinon.assert.notCalled(indexer.indexerDb.createOrderMatch);
    });
});

describe('Order_Match action handler @regression @tier2', function () {
    useOrderMatchHarness(bind);

    it('allows match when GIVE_OWNERSHIP mirrors GET_OWNERSHIP (both 0)', async function () {
        indexer.indexerDb.getOrderInfo.resolves(makeOrderInfo({ GIVE_OWNERSHIP: 0, GET_OWNERSHIP: 0 }));
        indexer.indexerDb.findOrderMatches.resolves([makeMatchInfo({ GIVE_OWNERSHIP: 0, GET_OWNERSHIP: 0 })]);

        const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME, ACTION_INDEX: 1 });
        await orderMatch.parse([], data, false);

        sinon.assert.calledOnce(indexer.indexerDb.createOrderMatch);
    });
});
