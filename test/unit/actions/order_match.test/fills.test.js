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
// Order_Match fills: full and partial fills, several makers in one pass, a
// fractional running remaining and a 0-decimal (NFT) partial fill.
// Part of the Order_Match suite; see ../order_match.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { createBaseData, createTokenInfo } = require('../../../fixtures/mocks');
const {
    BLOCK_TIME, makeOrderInfo, makeMatchInfo, useOrderMatchHarness,
} = require('./helpers/order_match_harness.js');

// Each test gets a fresh harness from useOrderMatchHarness; bind() hands it to
// the names the test bodies use.
let indexer, orderMatch;
const bind = (h) => { ({ indexer, orderMatch } = h); };

// ─── Full fill ────────────────────────────────────────────────────────

describe('Order_Match action handler @regression @tier2', function () {
    useOrderMatchHarness(bind);

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
});

describe('Order_Match action handler @regression @tier2', function () {
    useOrderMatchHarness(bind);

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
});

describe('Order_Match action handler @regression @tier2', function () {
    useOrderMatchHarness(bind);

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
});

// ─── Indivisibility: 0-decimal (NFT) fills are integer-only ───────────

describe('Order_Match action handler @regression @tier2', function () {
    useOrderMatchHarness(bind);

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
});
