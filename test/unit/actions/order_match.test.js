// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { createMockIndexer, createBaseData, createTokenInfo } = require('../../fixtures/mocks');

const Order_Match = require('../../../src/actions/order_match.js');

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
        SOURCE:         'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH',
        GIVE_COIN:      'BTC',
        GIVE_TICK:      'RAREPEPE',
        GIVE_REMAINING: '10',
        GET_COIN:       'BTC',
        GET_TICK:       'PEPECASH',
        GET_REMAINING:  '100',
        GET_ADDRESS:    'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH',
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
        SOURCE:         'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM',
        GIVE_COIN:      'BTC',
        GIVE_TICK:      'PEPECASH',
        GIVE_REMAINING: '100',
        GET_COIN:       'BTC',
        GET_TICK:       'RAREPEPE',
        GET_REMAINING:  '10',
        GET_ADDRESS:    'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM',
        // GET_PRICE = GIVE_AMOUNT / GET_AMOUNT = 100/10 = 10 : must be <= orderInfo.GIVE_PRICE (10)
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

    // OM-1: reciprocity gate. The order wants PEPECASH; a candidate whose GIVE side is a DIFFERENT
    // token (reverse-leg mismatch that the incomplete findOrderMatches predicate would return) must
    // be skipped, not settled - otherwise the taker is credited a token the maker never escrowed
    // (an unbounded mint out of the global escrow pool).
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

    it('partial fill : only the filled side is marked complete', async function () {
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

    it('two makers in one pass never release more escrow than the taker deposited', async function () {
        // Regression for the multi-maker over-fill bug: each fill must bound the
        // taker side by its RUNNING remaining, not the fetch-once orderInfo value.
        // Taker gives 10 RAREPEPE (escrow). Maker1 consumes 6, leaving 4; Maker2
        // wants 8. With the stale bound Maker2 released 8 (total 14 > 10 escrow),
        // over-releasing and tripping the per-block supply sanity check.
        indexer.indexerDb.getOrderInfo.resolves(makeOrderInfo({
            GIVE_REMAINING: '10', GET_REMAINING: '100', GIVE_PRICE: '10', GET_PRICE: '0.1',
        }));
        indexer.indexerDb.findOrderMatches.resolves([
            makeMatchInfo({ ACTION_INDEX: 2, GET_ADDRESS: 'mMaker1aaaaaaaaaaaaaaaaaaaaaaaaaaa',
                            GIVE_REMAINING: '60', GET_REMAINING: '6', GET_PRICE: '10' }),
            makeMatchInfo({ ACTION_INDEX: 3, GET_ADDRESS: 'mMaker2bbbbbbbbbbbbbbbbbbbbbbbbbbb',
                            GIVE_REMAINING: '80', GET_REMAINING: '8', GET_PRICE: '10' }),
        ]);

        // Capture the escrow rows handed to the ledger on each fill. The taker's
        // give-token (RAREPEPE) release is escrows[i] where tick === 'RAREPEPE'.
        const escrowsByFill = [];
        sinon.stub(indexer.util, 'processTransactionLedgerChanges')
            .callsFake(async (_db, _data, _credits, _debits, escrows) => { escrowsByFill.push(escrows); });

        const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME, ACTION_INDEX: 1 });
        await orderMatch.parse([], data, false);

        let takerReleased = 0;
        for (const escrows of escrowsByFill)
            for (const [tick, amount] of escrows)
                if (tick === 'RAREPEPE') takerReleased += Math.abs(Number(indexer.util.bcstr(amount)));

        assert.strictEqual(takerReleased, 10,
            `taker released ${takerReleased} RAREPEPE but only escrowed 10 (over-fill across makers)`);
    });

    it('fractional running remaining survives a fill exactly (no integer rounding)', async function () {
        // Regression for the bcsub-without-decimals bug: the running remaining was
        // subtracted at bcsub's default precision 0, so a fractional remaining
        // rounded to a whole number. 10 - 9.6 became "0" instead of "0.4": the
        // taker was marked complete with 0.4 still escrowed, and the second maker
        // (who wanted exactly that 0.4) was skipped as exhausted.
        indexer.indexerDb.getTokenInfo
            .withArgs('RAREPEPE', sinon.match.any, sinon.match.any)
            .resolves(createTokenInfo({ TICK: 'RAREPEPE', TICK_ID: 10, DECIMALS: 8, ALLOW_LIST: null, BLOCK_LIST: null }));
        indexer.indexerDb.getTokenInfo
            .withArgs('PEPECASH', sinon.match.any, sinon.match.any)
            .resolves(createTokenInfo({ TICK: 'PEPECASH', TICK_ID: 20, DECIMALS: 8, ALLOW_LIST: null, BLOCK_LIST: null }));

        // Taker: 10 RAREPEPE for 10 PEPECASH at price 1, both ways.
        indexer.indexerDb.getOrderInfo.resolves(makeOrderInfo({
            GIVE_REMAINING: '10', GET_REMAINING: '10', GIVE_PRICE: '1', GET_PRICE: '1',
        }));
        indexer.indexerDb.findOrderMatches.resolves([
            makeMatchInfo({ ACTION_INDEX: 2, GET_ADDRESS: 'mMaker1aaaaaaaaaaaaaaaaaaaaaaaaaaa',
                            GIVE_REMAINING: '9.6', GET_REMAINING: '9.6', GET_PRICE: '1' }),
            makeMatchInfo({ ACTION_INDEX: 3, GET_ADDRESS: 'mMaker2bbbbbbbbbbbbbbbbbbbbbbbbbbb',
                            GIVE_REMAINING: '0.4', GET_REMAINING: '0.4', GET_PRICE: '1' }),
        ]);

        const escrowsByFill = [];
        sinon.stub(indexer.util, 'processTransactionLedgerChanges')
            .callsFake(async (_db, _data, _credits, _debits, escrows) => { escrowsByFill.push(escrows); });

        const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME, ACTION_INDEX: 1 });
        await orderMatch.parse([], data, false);

        // Both fills must land: 9.6 then the fractional tail 0.4.
        sinon.assert.calledTwice(indexer.indexerDb.createOrderMatch);
        let takerReleased = '0';
        for (const escrows of escrowsByFill)
            for (const [tick, amount] of escrows)
                if (tick === 'RAREPEPE')
                    takerReleased = indexer.util.bcsub(takerReleased, amount, 8); // amounts are negative releases
        assert.strictEqual(String(takerReleased), '10',
            `taker released ${takerReleased} RAREPEPE of the 10 escrowed (fractional tail lost to rounding)`);
        // The taker completes only after the tail fill drains it to exactly 0.
        sinon.assert.calledWith(indexer.indexerDb.createOrderStatus, 999, 1, 'complete');

        // Negative control: the pre-fix default-precision subtraction rounds the
        // fractional remaining away, so this test fails against the old code.
        assert.strictEqual(String(indexer.util.bcsub('10', '9.6')), '0',
            'sanity: bcsub without decimals must round 0.4 to 0, else this regression is vacuous');
    });

    it('NFT (0-decimal) partial fill settles an integer amount, never a fractional artifact', async function () {
        // RAREPEPE is an indivisible NFT (DECIMALS=0); PEPECASH is divisible (DECIMALS=8).
        // The counterparty's PEPECASH remaining (3) priced at a non-terminating 1/3 ratio
        // makes the raw derived give_amount land at 0.999999999999999999… : a sub-ULP
        // artifact of the true value 1. The match engine must snap this onto RAREPEPE's
        // 0-decimal grid (→ 1), never credit a fractional unit of an indivisible token.
        indexer.indexerDb.getTokenInfo
            .withArgs('RAREPEPE', sinon.match.any, sinon.match.any)
            .resolves(createTokenInfo({ TICK: 'RAREPEPE', TICK_ID: 10, DECIMALS: 0, ALLOW_LIST: null, BLOCK_LIST: null }));
        indexer.indexerDb.getTokenInfo
            .withArgs('PEPECASH', sinon.match.any, sinon.match.any)
            .resolves(createTokenInfo({ TICK: 'PEPECASH', TICK_ID: 20, DECIMALS: 8, ALLOW_LIST: null, BLOCK_LIST: null }));

        const oneThird = '0.3333333333333333333333333333333333333333333333333333333333333333';
        indexer.indexerDb.getOrderInfo.resolves(makeOrderInfo({
            GIVE_TICK:      'RAREPEPE',   // NFT side
            GIVE_REMAINING: '10',
            GET_TICK:       'PEPECASH',
            GET_REMAINING:  '10',
            GIVE_PRICE:     '3',          // 3 PEPECASH per RAREPEPE
            GET_PRICE:      oneThird,     // 1/3 RAREPEPE per PEPECASH
        }));
        indexer.indexerDb.findOrderMatches.resolves([makeMatchInfo({
            GIVE_TICK:      'PEPECASH',
            GIVE_REMAINING: '3',          // 3 PEPECASH on offer
            GET_TICK:       'RAREPEPE',
            GET_REMAINING:  '1',          // wants 1 RAREPEPE
            GET_PRICE:      '3',          // <= orderInfo.GIVE_PRICE (3)
        })]);

        const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME, ACTION_INDEX: 1 });
        await orderMatch.parse([], data, false);

        sinon.assert.calledOnce(indexer.indexerDb.createOrderMatch);
        const settled = indexer.indexerDb.createOrderMatch.firstCall.args[0];
        // The NFT-denominated fill must be a whole number with no fractional component.
        // (MATCH_GIVE_AMOUNT is a bignumber; coerce to string for the grid assertions.)
        const giveStr = String(settled['MATCH_GIVE_AMOUNT']);
        assert.strictEqual(giveStr, '1', `NFT fill must snap to integer 1, got: ${giveStr}`);
        assert.ok(!giveStr.includes('.'), `NFT fill must carry no fractional part, got: ${giveStr}`);
    });

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

    it('native coin GIVE_TICK on orderInfo → pending_coinpay status, createCoinpayObligation called', async function () {
        // orderInfo is offering native coin (null GIVE_TICK), matchInfo has PEPECASH
        const nativeOrderInfo = makeOrderInfo({
            GIVE_TICK:      null,  // native coin side
            GIVE_REMAINING: '0.001',
            GET_TICK:       'PEPECASH',
            GET_REMAINING:  '100',
            GIVE_PRICE:     '100000',  // 1 PEPECASH per 0.00001 BTC → high ratio
            GET_PRICE:      '0.00001',
            SOURCE:         'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH',
        });
        const nativeMatchInfo = makeMatchInfo({
            GIVE_TICK:      'PEPECASH',
            GIVE_REMAINING: '100',
            GET_TICK:       null,   // native coin side
            GET_REMAINING:  '0.001',
            GET_PRICE:      '100000',
            GET_ADDRESS:    'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM',
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
            SOURCE:         'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH',
            GET_ADDRESS:    'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH',
        });
        const matchWithNullGive = makeMatchInfo({
            GIVE_TICK:      null,  // offering native coin
            GIVE_REMAINING: '0.001',
            GET_TICK:       'RAREPEPE',
            GET_REMAINING:  '10',
            GET_PRICE:      '0.0001',
            SOURCE:         'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM',
            GET_ADDRESS:    'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM',
        });

        indexer.indexerDb.getOrderInfo.resolves(orderWithNullGet);
        indexer.indexerDb.findOrderMatches.resolves([matchWithNullGive]);
        indexer.indexerDb.getTokenInfo.resolves(null); // both ticks are native

        const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME, ACTION_INDEX: 1, BLOCK_INDEX: 100 });
        await orderMatch.parse([], data, false);

        sinon.assert.calledOnce(indexer.indexerDb.createCoinpayObligation);
    });

    // findOrderMatches NULL-relaxes the reverse leg, so a token-for-COIN order
    // (GET_TICK null) can pair with a token-for-token maker whose GIVE_TICK is a real token.
    // That is not a coin trade (no side gives native coin against the coin-wanting side), and
    // settling it would mint a bogus COINPay obligation and mis-assign the coin/seller roles.
    // With COINPAY_NATIVE_RECIPROCITY active the reciprocity gate must skip it.
    it('skips a native match whose reverse leg is a real token, not native coin (, flag ON)', async function () {
        indexer.indexerDb.getTokenInfo
            .withArgs('SCAMTOKEN', sinon.match.any, sinon.match.any)
            .resolves(createTokenInfo({ TICK: 'SCAMTOKEN', TICK_ID: 30, ALLOW_LIST: null, BLOCK_LIST: null }));

        // orderInfo: GIVE RAREPEPE, GET native coin (GET_TICK null).
        const orderWantsCoin = makeOrderInfo({
            GIVE_TICK:      'RAREPEPE',
            GIVE_REMAINING: '10',
            GET_TICK:       null,      // wants native coin
            GET_REMAINING:  '0.001',
            GIVE_PRICE:     '0.0001',
            GET_PRICE:      '10000',
        });
        // matchInfo: GETs RAREPEPE (forward leg holds) but GIVES a REAL token, not native coin
        // (reverse leg violated - the NULL relaxation is what let this through findOrderMatches).
        const tokenMaker = makeMatchInfo({
            GIVE_TICK:      'SCAMTOKEN',   // a real token, NOT native coin
            GIVE_REMAINING: '100',
            GET_TICK:       'RAREPEPE',
            GET_REMAINING:  '10',
            GET_PRICE:      '0.0001',
        });

        indexer.indexerDb.getOrderInfo.resolves(orderWantsCoin);
        indexer.indexerDb.findOrderMatches.resolves([tokenMaker]);

        const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME, ACTION_INDEX: 1, BLOCK_INDEX: 100 });
        await orderMatch.parse([], data, false);

        sinon.assert.notCalled(indexer.indexerDb.createCoinpayObligation);
        sinon.assert.notCalled(indexer.indexerDb.createOrderMatch);
    });

    it('LEGACY (flag OFF): the mis-paired native match still settles (pre-flag-day replay parity)', async function () {
        actionsCtx.protocolChanges.isEnabled = sinon.stub().resolves(false);

        indexer.indexerDb.getTokenInfo
            .withArgs('SCAMTOKEN', sinon.match.any, sinon.match.any)
            .resolves(createTokenInfo({ TICK: 'SCAMTOKEN', TICK_ID: 30, ALLOW_LIST: null, BLOCK_LIST: null }));

        const orderWantsCoin = makeOrderInfo({
            GIVE_TICK:      'RAREPEPE',
            GIVE_REMAINING: '10',
            GET_TICK:       null,
            GET_REMAINING:  '0.001',
            GIVE_PRICE:     '0.0001',
            GET_PRICE:      '10000',
        });
        const tokenMaker = makeMatchInfo({
            GIVE_TICK:      'SCAMTOKEN',
            GIVE_REMAINING: '100',
            GET_TICK:       'RAREPEPE',
            GET_REMAINING:  '10',
            GET_PRICE:      '0.0001',
        });

        indexer.indexerDb.getOrderInfo.resolves(orderWantsCoin);
        indexer.indexerDb.findOrderMatches.resolves([tokenMaker]);

        const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME, ACTION_INDEX: 1, BLOCK_INDEX: 100 });
        await orderMatch.parse([], data, false);

        // Below the flag-day the legacy behaviour (bogus obligation) is preserved byte-for-byte.
        sinon.assert.calledOnce(indexer.indexerDb.createCoinpayObligation);
    });

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
            // regression that wrongly creates a match on this path fails (#1860).
            sinon.assert.notCalled(indexer.indexerDb.createOrderMatch);
        });

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

    // The GET_TICK-null routing branches (order_match native cases 3/4) only ever fire
    // for a MIS-PAIRED match - one side has a null GET_TICK (wants native coin) while the
    // counterparty's GIVE_TICK is a real token, so no side actually gives native coin against
    // the coin-wanting side. findOrderMatches' NULL-relaxed reverse leg lets the first shape
    // through; the second is not even reachable (its forward leg fails). With
    // COINPAY_NATIVE_RECIPROCITY active the reciprocity gate rejects both, so no bogus COINPay
    // obligation is minted and the coin/seller roles are never mis-assigned downstream.
    describe('native coin routing via GET_TICK null is rejected as mis-paired', function () {

        it('orderInfo GET_TICK null but matchInfo GIVES a real token (not coin) → skipped, no obligation', async function () {
            const orderWantsNative = makeOrderInfo({
                GIVE_TICK:      'RAREPEPE',
                GIVE_REMAINING: '10',
                GET_TICK:       null,     // wants native coin
                GET_REMAINING:  '0.001',
                GIVE_PRICE:     '0.0001',
                GET_PRICE:      '10000',
                GET_ADDRESS:    'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH',
            });
            const matchPaysNative = makeMatchInfo({
                GIVE_TICK:      'PEPECASH', // a real token, NOT native coin : the mis-pair
                GIVE_REMAINING: '100',
                GET_TICK:       'RAREPEPE',
                GET_REMAINING:  '10',
                GET_PRICE:      '0.0001',
                GET_ADDRESS:    'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM',
            });

            indexer.indexerDb.getOrderInfo.resolves(orderWantsNative);
            indexer.indexerDb.findOrderMatches.resolves([matchPaysNative]);
            indexer.indexerDb.getTokenInfo
                .withArgs('RAREPEPE', sinon.match.any, sinon.match.any)
                .resolves(createTokenInfo({ TICK: 'RAREPEPE', TICK_ID: 10, ALLOW_LIST: null, BLOCK_LIST: null }));
            indexer.indexerDb.getTokenInfo
                .withArgs('PEPECASH', sinon.match.any, sinon.match.any)
                .resolves(createTokenInfo({ TICK: 'PEPECASH', TICK_ID: 20, ALLOW_LIST: null, BLOCK_LIST: null }));

            const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME, ACTION_INDEX: 1, BLOCK_INDEX: 100 });
            await orderMatch.parse([], data, false);

            sinon.assert.notCalled(indexer.indexerDb.createCoinpayObligation);
            sinon.assert.notCalled(indexer.indexerDb.createOrderMatch);
        });

        it('matchInfo GET_TICK null against a token-for-token order (unreachable forward leg) → skipped', async function () {
            const orderPaysCoin = makeOrderInfo({
                GIVE_TICK:      'PEPECASH',
                GIVE_REMAINING: '100',
                GET_TICK:       'RAREPEPE', // non-null : a token-for-token order
                GET_REMAINING:  '10',
                GIVE_PRICE:     '10',
                GET_PRICE:      '0.1',
                GET_ADDRESS:    'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH',
            });
            const matchWantsNative = makeMatchInfo({
                GIVE_TICK:      'RAREPEPE', // non-null GIVE_TICK
                GIVE_REMAINING: '10',
                GET_TICK:       null,        // matchInfo wants native coin : forward leg cannot mirror
                GET_REMAINING:  '100',
                GET_PRICE:      '10',
                GET_ADDRESS:    'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM',
            });

            indexer.indexerDb.getOrderInfo.resolves(orderPaysCoin);
            indexer.indexerDb.findOrderMatches.resolves([matchWantsNative]);

            const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME, ACTION_INDEX: 1, BLOCK_INDEX: 100 });
            await orderMatch.parse([], data, false);

            sinon.assert.notCalled(indexer.indexerDb.createCoinpayObligation);
            sinon.assert.notCalled(indexer.indexerDb.createOrderMatch);
        });

    });

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

// Escrow/credit precision parity (#3736)
//
// Instant settlement pushes an escrow RELEASE for the same tick/address it
// CREDITS. The release amount used to be negated with JS unary minus
// (`-give_amount`), which coerces the mathjs BigNumber to an IEEE-754 double and
// truncates digits past ~15 sig-figs, while the paired credit kept the intact
// BigNumber. On a high-decimal tick the escrow magnitude then no longer equalled
// the credit : per-row drift that trips the supply SanityError. The fix negates
// in BigNumber space (bcsub), so the magnitudes are bit-identical.
describe('Order_Match escrow/credit precision parity @regression @tier1', function () {
    let indexer, actionsCtx, orderMatch, ledgerSpy;
    const BLOCK_TIME = 1700000000;
    // 18-decimal value whose 18th digit is lost by an IEEE-754 round-trip.
    const HI = '10.123456789012345678';

    beforeEach(function () {
        indexer    = createMockIndexer();
        actionsCtx = makeActionsCtx(indexer);
        orderMatch = new Order_Match(actionsCtx);
        // Both ticks are divisible to 18 dp so give/get_amount carry the full value.
        indexer.indexerDb.getTokenInfo
            .withArgs('RAREPEPE', sinon.match.any, sinon.match.any)
            .resolves(createTokenInfo({ TICK: 'RAREPEPE', TICK_ID: 10, DECIMALS: 18, ALLOW_LIST: null, BLOCK_LIST: null }));
        indexer.indexerDb.getTokenInfo
            .withArgs('PEPECASH', sinon.match.any, sinon.match.any)
            .resolves(createTokenInfo({ TICK: 'PEPECASH', TICK_ID: 20, DECIMALS: 18, ALLOW_LIST: null, BLOCK_LIST: null }));
        indexer.indexerDb.createActionIndex.resolves(999);
        // Capture the credits/debits/escrows handed to the ledger writer.
        ledgerSpy = sinon.stub(indexer.util, 'processTransactionLedgerChanges').resolves();
    });
    afterEach(function () { sinon.restore(); });

    it('escrow release is the bit-exact negation of the paired credit on an 18-dp fill', async function () {
        // Full fill at price 1: give_amount = get_amount = HI on both ticks.
        indexer.indexerDb.getOrderInfo.resolves(makeOrderInfo({
            GIVE_TICK: 'RAREPEPE', GET_TICK: 'PEPECASH',
            GIVE_REMAINING: HI, GET_REMAINING: HI, GIVE_PRICE: '1', GET_PRICE: '1',
        }));
        indexer.indexerDb.findOrderMatches.resolves([makeMatchInfo({
            GIVE_TICK: 'PEPECASH', GET_TICK: 'RAREPEPE',
            GIVE_REMAINING: HI, GET_REMAINING: HI, GET_PRICE: '1',
        })]);

        const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME, ACTION_INDEX: 1, BLOCK_INDEX: 100 });
        await orderMatch.parse([], data, false);

        sinon.assert.calledOnce(ledgerSpy);
        const credits = ledgerSpy.firstCall.args[2];
        const escrows = ledgerSpy.firstCall.args[4];

        // Both token sides settle instantly → one escrow + one credit per tick.
        for (const tick of ['RAREPEPE', 'PEPECASH']) {
            const esc = escrows.find(e => e[0] === tick);
            const creditSum = credits.filter(c => c[0] === tick)
                .reduce((s, c) => indexer.util.bcadd(s, c[1], 18), '0');
            assert.ok(esc, tick + ' must have an escrow release');
            // Bit-exact: escrow magnitude equals the credit, full 18 dp, no truncation.
            assert.strictEqual(String(esc[1]), '-' + HI, tick + ' escrow lost precision');
            assert.strictEqual(String(creditSum), HI, tick + ' credit drifted');
            // Escrow + credit nets to exactly zero in BigNumber space.
            assert.strictEqual(String(indexer.util.bcadd(esc[1], creditSum, 18)), '0',
                tick + ' escrow release != paired credit');
        }
    });

    it('negative control: JS unary minus on the same value DOES lose precision', function () {
        // Proves the assertion above has teeth: the pre-fix `-give_amount` path.
        const rounded = indexer.util.bcround(HI, 18);          // the BigNumber the handler holds
        assert.notStrictEqual(String(-rounded), '-' + HI,      // IEEE-754 round-trip corrupts it
            'sanity: unary minus must corrupt this value, else the parity test is vacuous');
        // ...while the shipped bcsub negation is exact.
        assert.strictEqual(String(indexer.util.bcsub(0, rounded, 18)), '-' + HI);
    });
});
