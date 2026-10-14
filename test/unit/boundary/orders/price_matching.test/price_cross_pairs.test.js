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
// ORDER_MATCH either side of order_match_price_cross_activation, on orders priced
// from their own amounts. The incoming order sells AAA for BBB; the resting order
// pays at most 10 BBB per AAA (gives 100 BBB for 10 AAA):
//   P1: the incoming order asks 15 BBB per AAA (10 AAA for 150 BBB): no cross.
//   P2: the incoming order asks 5 BBB per AAA (10 AAA for 50 BBB): crosses.
//   P3: the incoming order asks 10 BBB per AAA (10 AAA for 100 BBB): equal limits.
// Below the height the legacy comparison stands and fills P1 against the resting
// order's limit; from it P1 does not fill and P2 does, at the incoming order's
// ratio, which sits inside the resting order's limit. Part of the price-boundary
// suite; see ../price_matching.test.js.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { stubGate } = require('../../../../helpers/gate_modules.js');
const gateRegistry = require('../../../../../src/consensus/gate_registry');
const {
    PRICE_CROSS_KEY, TAKER, MAKER, bookHarness, priced, runBook, makerWithinLimit, assertConserved,
} = require('./helpers/price_cross_book.js');

// Above any height a chain reaches, below the unarmed sentinel.
const FAR_HEIGHT = 500000000;

const PAIRS = {
    P1: (u) => priced(u, 2, TAKER, 'AAA', '10', 'BBB', '150'),
    P2: (u) => priced(u, 2, TAKER, 'AAA', '10', 'BBB', '50'),
    P3: (u) => priced(u, 2, TAKER, 'AAA', '10', 'BBB', '100'),
};
const restingBid = (u) => priced(u, 1, MAKER, 'BBB', '100', 'AAA', '10');

// Four bids against an ask of 5 BBB per AAA; the one at 4 sits below the ask.
const fourBids = (u) => [
    priced(u, 1, MAKER, 'BBB', '100', 'AAA', '10'),
    priced(u, 2, MAKER, 'BBB', '40',  'AAA', '10'),
    priced(u, 3, MAKER, 'BBB', '60',  'AAA', '10'),
    priced(u, 4, MAKER, 'BBB', '80',  'AAA', '10'),
];

function registerRowTests() {
    describe('the row', function () {
        it('is unarmed on mainnet and testnet and active from regtest genesis, for every coin and for the hub read', function () {
            for (const coin of ['BTC', 'LTC', 'DOGE', null]) {
                const c = String(coin);
                assert.strictEqual(gateRegistry.activeAt(PRICE_CROSS_KEY, 'mainnet', coin, FAR_HEIGHT, null), false, c + ' mainnet');
                assert.strictEqual(gateRegistry.activeAt(PRICE_CROSS_KEY, 'testnet', coin, FAR_HEIGHT, null), false, c + ' testnet');
                assert.strictEqual(gateRegistry.activeAt(PRICE_CROSS_KEY, 'regtest', coin, 0, null), true, c + ' regtest genesis');
            }
        });

        it('is read by height at the ORDER_MATCH block, on the handler network and coin', async function () {
            const h = bookHarness(8, 8);
            const gate = stubGate(sinon, PRICE_CROSS_KEY, true);
            const run = await runBook(h, PAIRS.P2(h.u), [restingBid(h.u)]);
            assert.strictEqual(run.fills.length, 1);
            assert.ok(gate.calledWith(h.om.config['NETWORK'], h.om.config['COIN'], 100, null),
                'expected activeAt(key, network, coin, BLOCK_INDEX, null)');
        });

        it('is active on an unstubbed regtest handler', async function () {
            const h = bookHarness(8, 8);
            const run = await runBook(h, PAIRS.P1(h.u), [restingBid(h.u)]);
            assert.strictEqual(run.fills.length, 0, 'a non-crossing pair filled on regtest');
        });
    });
}

function registerBelowHeightTests() {
    describe('below the height: the legacy comparison, unchanged', function () {
        beforeEach(function () { stubGate(sinon, PRICE_CROSS_KEY, false); });

        it('P1 fills, and the resting order pays above its own limit', async function () {
            const h = bookHarness(8, 8);
            const maker = restingBid(h.u);
            const run = await runBook(h, PAIRS.P1(h.u), [maker]);
            assert.deepStrictEqual(run.fills, [{ give: '6.66666667', get: '100', maker: 1 }]);
            assert.ok(!makerWithinLimit(h.u, maker, run.fills[0]), 'the legacy fill is the one that breaks the limit');
            assertConserved(h.u, run.ledger);
        });

        it('P2 does not fill', async function () {
            const h = bookHarness(8, 8);
            const run = await runBook(h, PAIRS.P2(h.u), [restingBid(h.u)]);
            assert.deepStrictEqual(run.fills, []);
        });

        it('P3 fills in full', async function () {
            const h = bookHarness(8, 8);
            const run = await runBook(h, PAIRS.P3(h.u), [restingBid(h.u)]);
            assert.deepStrictEqual(run.fills, [{ give: '10', get: '100', maker: 1 }]);
        });

        it('a book of four bids fills only the one below the ask', async function () {
            const h = bookHarness(8, 8);
            const run = await runBook(h, priced(h.u, 9, TAKER, 'AAA', '50', 'BBB', '250'), fourBids(h.u));
            assert.deepStrictEqual(run.fills, [{ give: '8', get: '40', maker: 2 }]);
        });
    });
}

function registerFromHeightPairTests() {
    describe('from the height: the three pairs', function () {
        beforeEach(function () { stubGate(sinon, PRICE_CROSS_KEY, true); });

        it('P1 does not fill', async function () {
            const h = bookHarness(8, 8);
            const run = await runBook(h, PAIRS.P1(h.u), [restingBid(h.u)]);
            assert.deepStrictEqual(run.fills, []);
            assert.deepStrictEqual(run.ledger, {});
        });

        it('P2 fills at the incoming order\'s ratio, inside the resting order\'s limit', async function () {
            const h = bookHarness(8, 8);
            const maker = restingBid(h.u);
            const run = await runBook(h, PAIRS.P2(h.u), [maker]);
            // The incoming order gets exactly its ask (5 BBB per AAA); the resting order
            // pays 50 BBB for the 10 AAA it wanted, half its 10 BBB per AAA limit.
            assert.deepStrictEqual(run.fills, [{ give: '10', get: '50', maker: 1 }]);
            assert.ok(makerWithinLimit(h.u, maker, run.fills[0]));
            assert.deepStrictEqual(run.complete, [1, 2], 'both orders are complete: each got all it asked for');
            assertConserved(h.u, run.ledger);
        });

        it('P3 fills in full, as below the height', async function () {
            const h = bookHarness(8, 8);
            const run = await runBook(h, PAIRS.P3(h.u), [restingBid(h.u)]);
            assert.deepStrictEqual(run.fills, [{ give: '10', get: '100', maker: 1 }]);
            assertConserved(h.u, run.ledger);
        });
    });
}

function registerFromHeightPartialTests() {
    describe('from the height: partial fills', function () {
        beforeEach(function () { stubGate(sinon, PRICE_CROSS_KEY, true); });

        it('a partial fill of the incoming order leaves it open and completes the resting order', async function () {
            const h = bookHarness(8, 8);
            const maker = restingBid(h.u);
            const run = await runBook(h, priced(h.u, 2, TAKER, 'AAA', '30', 'BBB', '150'), [maker]);
            assert.deepStrictEqual(run.fills, [{ give: '10', get: '50', maker: 1 }]);
            assert.ok(makerWithinLimit(h.u, maker, run.fills[0]));
            assert.deepStrictEqual(run.complete, [1]);
            assertConserved(h.u, run.ledger);
        });

        it('a partial fill of the resting order completes the incoming order and leaves the resting one open', async function () {
            const h = bookHarness(8, 8);
            const maker = priced(h.u, 1, MAKER, 'BBB', '300', 'AAA', '30');
            const run = await runBook(h, PAIRS.P2(h.u), [maker]);
            assert.deepStrictEqual(run.fills, [{ give: '10', get: '50', maker: 1 }]);
            assert.ok(makerWithinLimit(h.u, maker, run.fills[0]));
            assert.deepStrictEqual(run.complete, [2]);
            assertConserved(h.u, run.ledger);
        });

        it('a resting order already part-filled is sized on its remaining amounts', async function () {
            const h = bookHarness(8, 8);
            // 300 BBB for 30 AAA with 120 BBB / 12 AAA left
            const maker = priced(h.u, 1, MAKER, 'BBB', '300', 'AAA', '30', '120', '12');
            const run = await runBook(h, priced(h.u, 2, TAKER, 'AAA', '20', 'BBB', '100'), [maker]);
            assert.deepStrictEqual(run.fills, [{ give: '12', get: '60', maker: 1 }]);
            assert.ok(makerWithinLimit(h.u, maker, run.fills[0]));
            assert.deepStrictEqual(run.complete, [1]);
            assertConserved(h.u, run.ledger);
        });
    });
}

function registerFromHeightBookTests() {
    describe('from the height: several resting orders at different prices', function () {
        beforeEach(function () { stubGate(sinon, PRICE_CROSS_KEY, true); });

        it('a book of four bids fills the three that cross, best bid first, and skips the one below the ask', async function () {
            const h = bookHarness(8, 8);
            const makers = fourBids(h.u);
            const run = await runBook(h, priced(h.u, 9, TAKER, 'AAA', '50', 'BBB', '250'), makers);
            assert.deepStrictEqual(run.fills, [
                { give: '10', get: '50', maker: 1 },
                { give: '10', get: '50', maker: 4 },
                { give: '10', get: '50', maker: 3 },
            ]);
            for (const f of run.fills)
                assert.ok(makerWithinLimit(h.u, makers.find((m) => m.ACTION_INDEX === f.maker), f), 'maker ' + f.maker);
            assert.deepStrictEqual(run.complete, [1, 3, 4]);
            assertConserved(h.u, run.ledger);
        });

        it('stops at the incoming order\'s remaining amounts across several bids', async function () {
            const h = bookHarness(8, 8);
            const makers = fourBids(h.u).filter((m) => m.ACTION_INDEX !== 2);
            const run = await runBook(h, priced(h.u, 9, TAKER, 'AAA', '25', 'BBB', '125'), makers);
            assert.deepStrictEqual(run.fills, [
                { give: '10', get: '50', maker: 1 },
                { give: '10', get: '50', maker: 4 },
                { give: '5',  get: '25', maker: 3 },
            ]);
            assert.deepStrictEqual(run.complete, [1, 4, 9]);
            assertConserved(h.u, run.ledger);
        });
    });
}

describe('ORDER_MATCH price-cross activation @regression @tier2', function () {
    afterEach(function () { sinon.restore(); });

    registerRowTests();
    registerBelowHeightTests();
    registerFromHeightPairTests();
    registerFromHeightPartialTests();
    registerFromHeightBookTests();
});
