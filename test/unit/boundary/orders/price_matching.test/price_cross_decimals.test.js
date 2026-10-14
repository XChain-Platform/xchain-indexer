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
// ORDER_MATCH from order_match_price_cross_activation, across every pair of token
// decimals. The incoming order sells 7 AAA for 20 BBB (a non-terminating ask of
// 2.857142... BBB per AAA) into four bids, one of them below the ask. Every fill
// must sit on both tick grids, the bid below the ask must never fill, the ledger
// must net to zero per tick, and neither side may settle worse than its own limit
// by more than one grid unit of each tick. The fill math rounds each derived amount
// half-up onto its own grid, so on a coarse grid a side can pay up to one unit of the
// tick it gives beyond its limit, or receive one unit less of the tick it gets; that
// rounding predates the activation and is the same in both eras. Part of the
// price-boundary suite; see ../price_matching.test.js.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { stubGate } = require('../../../../helpers/gate_modules.js');
const {
    PRICE_CROSS_KEY, TAKER, MAKER, bookHarness, priced, runBook, gridUnit, onGrid,
    makerWithinLimit, takerWithinLimit, assertConserved,
} = require('./helpers/price_cross_book.js');

const DECIMALS = [0, 1, 2, 7, 8, 9, 17, 18];
const BELOW_ASK = 13;

function book(u) {
    return {
        taker: priced(u, 20, TAKER, 'AAA', '7', 'BBB', '20'),
        makers: [
            priced(u, 11, MAKER, 'BBB', '11', 'AAA', '2'),          // bids 5.5 per AAA
            priced(u, 12, MAKER, 'BBB', '10', 'AAA', '3'),          // bids 3.333...
            priced(u, BELOW_ASK, MAKER, 'BBB', '5', 'AAA', '2'),    // bids 2.5: below the ask
            priced(u, 14, MAKER, 'BBB', '7',  'AAA', '2'),          // bids 3.5
        ],
    };
}

function assertFill(u, f, maker, taker, decA, decB) {
    assert.ok(onGrid(f.give, decA) && onGrid(f.get, decB), 'fill off grid: ' + JSON.stringify(f));
    assert.ok(u.bcgt(f.give, '0') && u.bcgt(f.get, '0'), 'zero fill: ' + JSON.stringify(f));
    assert.ok(!u.bcgt(f.get, maker.GIVE_AMOUNT) && !u.bcgt(f.give, maker.GET_AMOUNT),
        'fill beyond the resting order: ' + JSON.stringify(f));
    assert.ok(makerWithinLimit(u, maker, f, gridUnit(u, decA), gridUnit(u, decB)),
        'resting order ' + f.maker + ' paid ' + f.get + ' BBB for ' + f.give + ' AAA, beyond its limit');
    assert.ok(takerWithinLimit(u, taker, f, gridUnit(u, decB), gridUnit(u, decA)),
        'incoming order gave ' + f.give + ' AAA for ' + f.get + ' BBB, beyond its limit');
}

describe('ORDER_MATCH price-cross activation, every token-decimals pair @regression @tier2', function () {
    beforeEach(function () { stubGate(sinon, PRICE_CROSS_KEY, true); });
    afterEach(function () { sinon.restore(); });

    for (const decA of DECIMALS) for (const decB of DECIMALS) {
        it('decA=' + decA + ' decB=' + decB, async function () {
            const h = bookHarness(decA, decB);
            const u = h.u;
            const { taker, makers } = book(u);
            const run = await runBook(h, taker, makers);

            assert.ok(run.fills.length > 0, 'nothing filled');
            assert.ok(!run.fills.some((f) => f.maker === BELOW_ASK), 'the bid below the ask filled');
            for (const f of run.fills)
                assertFill(u, f, makers.find((m) => m.ACTION_INDEX === f.maker), taker, decA, decB);
            const gave = run.fills.reduce((acc, f) => u.bcadd(acc, f.give, 18), '0');
            assert.ok(!u.bcgt(gave, taker.GIVE_AMOUNT), 'the incoming order gave more than it escrowed');
            assertConserved(u, run.ledger);
        });
    }
});
