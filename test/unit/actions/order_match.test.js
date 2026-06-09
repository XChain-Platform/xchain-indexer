// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { createMockIndexer, createBaseData, createTokenInfo } = require('../../fixtures/mocks');

const Order_Match = require('../../../src/actions/order_match.js');

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

function makeOrderInfo(overrides = {}) {
    return {
        ACTION_INDEX:   1,
        SOURCE:         '1SourceAddressXXXXXXXXXXXXXXXYs6gYt',
        GIVE_COIN:      'BTC',
        GIVE_TICK:      'RAREPEPE',
        GIVE_REMAINING: '10',
        GET_COIN:       'BTC',
        GET_TICK:       'PEPECASH',
        GET_REMAINING:  '100',
        GET_ADDRESS:    '1SourceAddressXXXXXXXXXXXXXXXYs6gYt',
        // GIVE_PRICE = GET_AMOUNT / GIVE_AMOUNT = 100/10 = 10  (PEPECASH per RAREPEPE)
        GIVE_PRICE:     '10',
        // GET_PRICE  = GIVE_AMOUNT / GET_AMOUNT = 10/100 = 0.1 (RAREPEPE per PEPECASH)
        GET_PRICE:      '0.1',
        ALLOW_LIST:     null,
        BLOCK_LIST:     null,
        ORDER_STATUS:   'open',
        ...overrides,
    };
}

function makeMatchInfo(overrides = {}) {
    return {
        ACTION_INDEX:   2,
        SOURCE:         '1DestAddressXXXXXXXXXXXXXXXXXaKc5Z',
        GIVE_COIN:      'BTC',
        GIVE_TICK:      'PEPECASH',
        GIVE_REMAINING: '100',
        GET_COIN:       'BTC',
        GET_TICK:       'RAREPEPE',
        GET_REMAINING:  '10',
        GET_ADDRESS:    '1DestAddressXXXXXXXXXXXXXXXXXaKc5Z',
        // GET_PRICE = GIVE_AMOUNT / GET_AMOUNT = 100/10 = 10 — must be <= orderInfo.GIVE_PRICE (10)
        GET_PRICE:      '10',
        ALLOW_LIST:     null,
        BLOCK_LIST:     null,
        ORDER_STATUS:   'open',
        ...overrides,
    };
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('Order_Match action handler @regression @tier2', function () {
    let indexer;
    let actionsCtx;
    let orderMatch;

    const BLOCK_TIME = 1700000000;

    beforeEach(function () {
        indexer    = createMockIndexer();
        actionsCtx = makeActionsCtx(indexer);
        orderMatch = new Order_Match(actionsCtx);

        // Default getTokenInfo stubs
        indexer.indexerDb.getTokenInfo
            .withArgs('RAREPEPE', sinon.match.any, sinon.match.any)
            .resolves(createTokenInfo({ TICK: 'RAREPEPE', TICK_ID: 10, ALLOW_LIST: null, BLOCK_LIST: null }));
        indexer.indexerDb.getTokenInfo
            .withArgs('PEPECASH', sinon.match.any, sinon.match.any)
            .resolves(createTokenInfo({ TICK: 'PEPECASH', TICK_ID: 20, ALLOW_LIST: null, BLOCK_LIST: null }));

        // Default: new ACTION_INDEX created for ORDER_MATCH
        indexer.indexerDb.createActionIndex.resolves(999);
    });

    afterEach(function () {
        sinon.restore();
    });

    // ─── No matching order ────────────────────────────────────────────────

    it('returns early when orderInfo is null (order not found)', async function () {
        indexer.indexerDb.getOrderInfo.resolves(null);

        const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME, ACTION_INDEX: 1 });
        await orderMatch.parse([], data, false);

        sinon.assert.notCalled(indexer.indexerDb.findOrderMatches);
        sinon.assert.notCalled(indexer.indexerDb.createOrderMatch);
    });

    it('no matches found — createOrderMatch is never called', async function () {
        indexer.indexerDb.getOrderInfo.resolves(makeOrderInfo());
        indexer.indexerDb.findOrderMatches.resolves([]);

        const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME, ACTION_INDEX: 1 });
        await orderMatch.parse([], data, false);

        sinon.assert.calledOnce(indexer.indexerDb.findOrderMatches);
        sinon.assert.notCalled(indexer.indexerDb.createOrderMatch);
    });

    // ─── Price validation ────────────────────────────────────────────────

    it('skips match when matchInfo.GET_PRICE > orderInfo.GIVE_PRICE', async function () {
        // GIVE_PRICE=5, but match wants GET_PRICE=10 — mismatch → skip
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

    // ─── Full fill ────────────────────────────────────────────────────────

    it('full fill marks both orders complete', async function () {
        // GIVE_REMAINING == GIVE_AMOUNT of match → both fully filled
        // give_amount = matchInfo.GIVE_REMAINING * orderInfo.GET_PRICE = 100 * 0.1 = 10 (== order.GIVE_REMAINING)
        // get_amount  = give_amount * orderInfo.GIVE_PRICE = 10 * 10 = 100 (== order.GET_REMAINING)
        indexer.indexerDb.getOrderInfo.resolves(makeOrderInfo({
            GIVE_REMAINING: '10',
            GET_REMAINING:  '100',
            GIVE_PRICE:     '10',
            GET_PRICE:      '0.1',
        }));
        indexer.indexerDb.findOrderMatches.resolves([makeMatchInfo({
            GIVE_REMAINING: '100',
            GET_REMAINING:  '10',
            GET_PRICE:      '10',
        })]);

        const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME, ACTION_INDEX: 1 });
        await orderMatch.parse([], data, false);

        // createOrderStatus called twice (once per order side going to 'complete')
        assert.ok(indexer.indexerDb.createOrderStatus.callCount >= 2,
            `Expected createOrderStatus called at least twice, got ${indexer.indexerDb.createOrderStatus.callCount}`);
    });

    // ─── Partial fill ────────────────────────────────────────────────────

    it('partial fill — only the filled side is marked complete', async function () {
        // Match has 50 PEPECASH (half of order's GET_REMAINING 100):
        // give_amount = 50 * 0.1 = 5 (5 RAREPEPE out of 10 remaining in order → order partially filled)
        // get_amount  = 5  * 10  = 50 (50 PEPECASH = all of match's GIVE_REMAINING → match fully filled)
        indexer.indexerDb.getOrderInfo.resolves(makeOrderInfo({
            GIVE_REMAINING: '10',
            GET_REMAINING:  '100',
            GIVE_PRICE:     '10',
            GET_PRICE:      '0.1',
        }));
        indexer.indexerDb.findOrderMatches.resolves([makeMatchInfo({
            GIVE_REMAINING: '50',
            GET_REMAINING:  '5',
            GET_PRICE:      '10',
        })]);

        const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME, ACTION_INDEX: 1 });
        await orderMatch.parse([], data, false);

        sinon.assert.calledOnce(indexer.indexerDb.createOrderMatch);
        // At least one createOrderStatus call for the match side becoming complete
        sinon.assert.called(indexer.indexerDb.createOrderStatus);
    });

    // ─── Skips with zero remaining ────────────────────────────────────────

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
        const matchAddr = '1DestAddressXXXXXXXXXXXXXXXXXaKc5Z';
        indexer.indexerDb.getOrderInfo.resolves(makeOrderInfo({ BLOCK_LIST: '6' }));
        indexer.indexerDb.findOrderMatches.resolves([makeMatchInfo({ GET_ADDRESS: matchAddr })]);
        // BLOCK_LIST includes the match GET_ADDRESS
        indexer.indexerDb.getList.resolves([matchAddr]);

        const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME, ACTION_INDEX: 1 });
        await orderMatch.parse([], data, false);

        sinon.assert.notCalled(indexer.indexerDb.createOrderMatch);
    });

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
        const orderAddr = '1SourceAddressXXXXXXXXXXXXXXXYs6gYt';
        const matchAddr = '1DestAddressXXXXXXXXXXXXXXXXXaKc5Z';

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

    it('allows match when GIVE_OWNERSHIP mirrors GET_OWNERSHIP (both 0)', async function () {
        indexer.indexerDb.getOrderInfo.resolves(makeOrderInfo({ GIVE_OWNERSHIP: 0, GET_OWNERSHIP: 0 }));
        indexer.indexerDb.findOrderMatches.resolves([makeMatchInfo({ GIVE_OWNERSHIP: 0, GET_OWNERSHIP: 0 })]);

        const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME, ACTION_INDEX: 1 });
        await orderMatch.parse([], data, false);

        sinon.assert.calledOnce(indexer.indexerDb.createOrderMatch);
    });

    // ─── Native coin match (pending_coinpay settlement) ───────────────────

    it('native coin GIVE_TICK on orderInfo → pending_coinpay status, createCoinpayObligation called', async function () {
        // orderInfo is offering native coin (null GIVE_TICK), matchInfo has PEPECASH
        const nativeOrderInfo = makeOrderInfo({
            GIVE_TICK:      null,  // native coin side
            GIVE_REMAINING: '0.001',
            GET_TICK:       'PEPECASH',
            GET_REMAINING:  '100',
            GIVE_PRICE:     '100000',  // 1 PEPECASH per 0.00001 BTC → high ratio
            GET_PRICE:      '0.00001',
            SOURCE:         '1SourceAddressXXXXXXXXXXXXXXXYs6gYt',
        });
        const nativeMatchInfo = makeMatchInfo({
            GIVE_TICK:      'PEPECASH',
            GIVE_REMAINING: '100',
            GET_TICK:       null,   // native coin side
            GET_REMAINING:  '0.001',
            GET_PRICE:      '100000',
            GET_ADDRESS:    '1DestAddressXXXXXXXXXXXXXXXXXaKc5Z',
        });

        indexer.indexerDb.getOrderInfo.resolves(nativeOrderInfo);
        indexer.indexerDb.findOrderMatches.resolves([nativeMatchInfo]);
        indexer.indexerDb.getTokenInfo
            .withArgs(null, sinon.match.any, sinon.match.any).resolves(null)
            .withArgs('PEPECASH', sinon.match.any, sinon.match.any)
            .resolves(createTokenInfo({ TICK: 'PEPECASH', TICK_ID: 20, ALLOW_LIST: null, BLOCK_LIST: null }));

        const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME, ACTION_INDEX: 1, BLOCK_INDEX: 100 });
        await orderMatch.parse([], data, false);

        sinon.assert.calledOnce(indexer.indexerDb.createCoinpayObligation);
        sinon.assert.calledOnce(indexer.indexerDb.createCoinpayStatus);
        // Instant status set to pending_coinpay
        assert.strictEqual(data['STATUS'], 'pending_coinpay');
    });

    it('native coin GET_TICK on orderInfo → pending_coinpay, matchInfo is coin payer', async function () {
        // orderInfo wants native coin (null GET_TICK), matchInfo provides it (null GIVE_TICK)
        const orderWithNullGet = makeOrderInfo({
            GIVE_TICK:      'RAREPEPE',
            GIVE_REMAINING: '10',
            GET_TICK:       null,  // wants native coin
            GET_REMAINING:  '0.001',
            GIVE_PRICE:     '0.0001',
            GET_PRICE:      '10000',
            SOURCE:         '1SourceAddressXXXXXXXXXXXXXXXYs6gYt',
            GET_ADDRESS:    '1SourceAddressXXXXXXXXXXXXXXXYs6gYt',
        });
        const matchWithNullGive = makeMatchInfo({
            GIVE_TICK:      null,  // offering native coin
            GIVE_REMAINING: '0.001',
            GET_TICK:       'RAREPEPE',
            GET_REMAINING:  '10',
            GET_PRICE:      '0.0001',
            SOURCE:         '1DestAddressXXXXXXXXXXXXXXXXXaKc5Z',
            GET_ADDRESS:    '1DestAddressXXXXXXXXXXXXXXXXXaKc5Z',
        });

        indexer.indexerDb.getOrderInfo.resolves(orderWithNullGet);
        indexer.indexerDb.findOrderMatches.resolves([matchWithNullGive]);
        indexer.indexerDb.getTokenInfo.resolves(null); // both ticks are native

        const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME, ACTION_INDEX: 1, BLOCK_INDEX: 100 });
        await orderMatch.parse([], data, false);

        sinon.assert.calledOnce(indexer.indexerDb.createCoinpayObligation);
    });

    // ─── Ownership order matching ─────────────────────────────────────────

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

    // ─── Ownership single-fill enforcement ────────────────────────────────

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

        // Single-fill enforcement — must skip partial matches for ownership orders
        sinon.assert.notCalled(indexer.indexerDb.createOrderMatch);
    });
});
