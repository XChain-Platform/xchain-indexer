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
// The order book harness the price-cross suites share: a mock indexer with two
// tokens of chosen decimals, orders priced from their own amounts exactly as
// db/orders/order_info.js getOrderInfo prices them, one ORDER_MATCH pass over a
// best-bid-first book, and the limit and conservation checks every case applies.

'use strict';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData, createTokenInfo } = require('../../../../../fixtures/mocks');
const OrderMatch = require('../../../../../../src/actions/order_match/index.js');

const PRICE_CROSS_KEY = 'order_match_price_cross_activation.ORDER_MATCH_PRICE_CROSS_ACTIVATION';
const TAKER = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const MAKER = 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM';
const BLOCK_TIME = 1700000000;

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

// A mock indexer whose AAA and BBB tokens carry the given decimals.
function bookHarness(decA, decB) {
    const ix = createMockIndexer();
    const om = new OrderMatch(makeActionsCtx(ix));
    ix.indexerDb.getTokenInfo.withArgs('AAA', sinon.match.any, sinon.match.any)
        .resolves(createTokenInfo({ TICK: 'AAA', TICK_ID: 10, DECIMALS: decA }));
    ix.indexerDb.getTokenInfo.withArgs('BBB', sinon.match.any, sinon.match.any)
        .resolves(createTokenInfo({ TICK: 'BBB', TICK_ID: 20, DECIMALS: decB }));
    let next = 1000;
    ix.indexerDb.createActionIndex.callsFake(async () => ++next);
    return { ix, om, u: ix.util };
}

// An order row priced the way getOrderInfo prices it, from its own amounts:
// GIVE_PRICE = GET_AMOUNT / GIVE_AMOUNT (its ask), GET_PRICE = GIVE_AMOUNT / GET_AMOUNT (its bid).
function priced(u, actionIndex, source, giveTick, giveAmt, getTick, getAmt, giveRem, getRem) {
    return {
        ACTION_INDEX: actionIndex, SOURCE: source, GET_ADDRESS: source,
        GIVE_COIN: 'BTC', GIVE_TICK: giveTick, GIVE_AMOUNT: giveAmt,
        GET_COIN: 'BTC', GET_TICK: getTick, GET_AMOUNT: getAmt,
        GIVE_REMAINING: giveRem === undefined ? giveAmt : giveRem,
        GET_REMAINING: getRem === undefined ? getAmt : getRem,
        GIVE_PRICE: u.getPrice(getAmt, giveAmt),
        GET_PRICE: u.getPrice(giveAmt, getAmt),
        ALLOW_LIST: null, BLOCK_LIST: null, ORDER_STATUS: 'open',
    };
}

// Per-tick sums of the credit, debit and escrow rows the pass wrote.
function ledgerOf(h) {
    const sum = {};
    const add = (k, v) => { sum[k] = h.u.bcstr(h.u.bcadd(sum[k] || '0', v, 18)); };
    for (const c of h.ix.indexerDb.createCredit.getCalls()) add('credit:' + c.args[1], c.args[2]);
    for (const c of h.ix.indexerDb.createDebit.getCalls())  add('debit:' + c.args[1], c.args[2]);
    for (const c of h.ix.indexerDb.createEscrow.getCalls()) add('escrow:' + c.args[1], c.args[2]);
    return sum;
}

// Run the incoming order against the resting book, ordered best bid first as
// findOrderMatches orders it. Returns every fill (snapshotted, since recordFill
// reuses `data`), the ledger sums and the order indexes marked complete.
async function runBook(h, taker, makers) {
    h.ix.indexerDb.getOrderInfo.resolves(taker);
    h.ix.indexerDb.findOrderMatches.resolves(h.u.sortPriceActionIndex(makers.slice()));
    const fills = [];
    h.ix.indexerDb.createOrderMatch.callsFake(async (d, orderInfo, matchInfo) => {
        fills.push({ give: d['MATCH_GIVE_AMOUNT'], get: d['MATCH_GET_AMOUNT'], maker: matchInfo['ACTION_INDEX'] });
    });
    const data = createBaseData({ ACTION: 'ORDER_MATCH', BLOCK_TIME, ACTION_INDEX: taker.ACTION_INDEX });
    await h.om.parse([], data, false);
    const complete = h.ix.indexerDb.createOrderStatus.getCalls()
        .filter((c) => c.args[2] === 'complete').map((c) => c.args[1]).sort((a, b) => a - b);
    return { fills, ledger: ledgerOf(h), complete };
}

function gridUnit(u, decimals) {
    return u.bcstr(u.bcdiv('1', '1' + '0'.repeat(decimals), decimals));
}

function onGrid(amount, decimals) {
    return (String(amount).split('.')[1] || '').length <= decimals;
}

// A resting order gives `get` of its GIVE tick and receives `give` of its GET tick in
// a fill. Its limit holds when get / give <= GIVE_AMOUNT / GET_AMOUNT, that is
// get * GET_AMOUNT <= give * GIVE_AMOUNT. `receiveSlack` is added to what it receives
// and `paySlack` taken from what it pays, so a caller can allow each tick's rounding.
function makerWithinLimit(u, maker, fill, receiveSlack, paySlack) {
    const received = u.bcadd(fill.give, receiveSlack || '0', 18);
    const paid = u.bcsub(fill.get, paySlack || '0', 18);
    return !u.bcgt(u.bcmul(paid, maker.GET_AMOUNT, 64), u.bcmul(received, maker.GIVE_AMOUNT, 64));
}

// The incoming order gives `give` of its GIVE tick and receives `get` of its GET
// tick. Its limit holds when get * GIVE_AMOUNT >= give * GET_AMOUNT, with the same
// two slacks as above.
function takerWithinLimit(u, taker, fill, receiveSlack, paySlack) {
    const received = u.bcadd(fill.get, receiveSlack || '0', 18);
    const paid = u.bcsub(fill.give, paySlack || '0', 18);
    return !u.bclt(u.bcmul(received, taker.GIVE_AMOUNT, 64), u.bcmul(paid, taker.GET_AMOUNT, 64));
}

// Every tick nets to zero: what the pass credits on a tick is exactly the escrow it
// releases on that tick, and nothing is debited from a free balance.
function assertConserved(u, ledger) {
    for (const t of ['AAA', 'BBB']) {
        const net = u.bcadd(ledger['credit:' + t] || '0', ledger['escrow:' + t] || '0', 18);
        assert.strictEqual(u.bcstr(net), '0', t + ' credit ' + ledger['credit:' + t] + ' + escrow ' + ledger['escrow:' + t] + ' != 0');
        assert.ok(!ledger['debit:' + t], 'the match debited a free ' + t + ' balance');
    }
}

module.exports = {
    PRICE_CROSS_KEY, TAKER, MAKER,
    bookHarness, priced, runBook, gridUnit, onGrid, makerWithinLimit, takerWithinLimit, assertConserved,
};
