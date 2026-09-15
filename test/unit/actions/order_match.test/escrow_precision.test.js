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
// Order_Match escrow/credit precision parity on an 18-decimal fill.
// Part of the Order_Match suite; see ../order_match.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { createMockIndexer, createBaseData, createTokenInfo } = require('../../../fixtures/mocks');
const {
    makeActionsCtx, makeOrderInfo, makeMatchInfo,
} = require('./helpers/order_match_harness.js');

const Order_Match = require('../../../../src/actions/order_match/index.js');

let indexer, actionsCtx, orderMatch, ledgerSpy;

// 18-decimal value whose 18th digit is lost by an IEEE-754 round-trip.
const HI = '10.123456789012345678';

// Escrow/credit precision parity
//
// Instant settlement pushes an escrow RELEASE for the same tick/address it
// CREDITS. The release amount must not be negated with JS unary minus
// (`-give_amount`), which coerces the mathjs BigNumber to an IEEE-754 double and
// truncates digits past ~15 sig-figs, while the paired credit kept the intact
// BigNumber. On a high-decimal tick the escrow magnitude then no longer equalled
// the credit : per-row drift that trips the supply SanityError. The fix negates
// in BigNumber space (bcsub), so the magnitudes are bit-identical.
describe('Order_Match escrow/credit precision parity @regression @tier1', function () {
    const BLOCK_TIME = 1700000000;

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
});

describe('Order_Match escrow/credit precision parity @regression @tier1', function () {
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

    it('negative control: JS unary minus on the same value DOES lose precision', function () {
        // Proves the assertion above has teeth: the pre-fix `-give_amount` path.
        const rounded = indexer.util.bcround(HI, 18);          // the BigNumber the handler holds
        assert.notStrictEqual(String(-rounded), '-' + HI,      // IEEE-754 round-trip corrupts it
            'sanity: unary minus must corrupt this value, else the parity test is vacuous');
        // ...while the shipped bcsub negation is exact.
        assert.strictEqual(String(indexer.util.bcsub(0, rounded, 18)), '-' + HI);
    });
});
