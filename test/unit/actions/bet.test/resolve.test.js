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
// BET Format 3 (resolve feed): the section-7 worked example, void and rake
// payouts, resolve rejections and the outcome-range halt. Part of the BET suite;
// see ../bet.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createMockIndexer, createBaseData, createTokenInfo } = require('../../../fixtures/mocks');
const { ORACLE, ALICE, BOB, CAROL, T0, feedInfo } = require('./helpers/bet_fixtures.js');

const Bet = require('../../../../src/actions/bet/index.js');

let indexer, actionsCtx, handler, ledgerSpy;

/*****************************************************************
 * Format 3 - Resolve Feed: the section-7 worked example
 ****************************************************************/

function armWorkedExample() {
    indexer.indexerDb.getBetFeedInfo.resolves(feedInfo({ FEED_STATUS: 'closed' }));
    indexer.indexerDb.getOpenBetsByFeed.resolves([
        { ACTION_INDEX: 10, OUTCOME: 0, AMOUNT: '10.00000000', SOURCE: ALICE },
        { ACTION_INDEX: 11, OUTCOME: 1, AMOUNT: '5.00000000',  SOURCE: BOB },
        { ACTION_INDEX: 12, OUTCOME: 0, AMOUNT: '2.50000000',  SOURCE: CAROL },
    ]);
}

describe('BET action handler @regression @tier2', function () {
    beforeEach(function () {
        indexer = createMockIndexer();
        actionsCtx = {
            config: indexer.config,
            util: indexer.util,
            mapper: indexer.mapper,
            decoderDb: indexer.decoderDb,
            indexerDb: indexer.indexerDb,
            protocolChanges: indexer.protocolChanges,
            processAction: sinon.stub().resolves(),
        };
        handler = new Bet(actionsCtx);
        indexer.util.resetLists();

        // Wager token: 8 decimals, distinct TICK_ID (2) from the GAS token (1)
        indexer.indexerDb.getTokenInfo.resolves(createTokenInfo({ TICK: 'TEST', TICK_ID: 2, DECIMALS: 8 }));
        // Generous balances: {tick_id: amount}; 1 = GAS/XCHAIN, 2 = TEST
        indexer.indexerDb.getAddressBalances.resolves({ 1: '1000', 2: '1000' });
        // Capture ledger changes instead of writing them
        ledgerSpy = sinon.stub(indexer.util, 'processTransactionLedgerChanges').resolves();
    });

    it('settles the worked example exactly: payouts, fee, dust, conservation', async function () {
        armWorkedExample();
        const data = createBaseData({ ACTION: 'BET', FORMAT: 3, SOURCE: ORACLE, BLOCK_TIME: T0 + 86400 + 10 });
        await handler.parse(['3', '5', '0', ''], data, null);
        assert.strictEqual(data['STATUS'], 'valid');

        const [, , credits, , escrows] = ledgerSpy.firstCall.args;
        // T=17.5, W=12.5, fee=0.175, pot=17.325: A 13.86, C 3.465, oracle 0.175, dust 0
        assert.deepStrictEqual(credits.map(c => [c[0], String(c[1]), c[2]]), [
            ['TEST', '13.86', ALICE],   // bignumber-normalized string forms
            ['TEST', '3.465', CAROL],
            ['TEST', '0.175', ORACLE],
        ]);
        // Every open bet's escrow released exactly once, winner or loser
        assert.strictEqual(escrows.length, 3);
        const released = escrows.reduce((s, e) => indexer.util.bcadd(s, indexer.util.bcsub(0, e[1], 8), 8), 0);
        assert.strictEqual(String(released), '17.5');
        // Conservation: credits out == escrow in (13.86 + 3.465 + 0.175 = 17.5 = T)
        const out = credits.reduce((s, c) => indexer.util.bcadd(s, c[1], 8), 0);
        assert.strictEqual(String(out), '17.5');

        // One terminal flip per bet on exactly one path
        assert.ok(indexer.indexerDb.setBetSettled.calledWith(10, 'won',  data['BLOCK_INDEX']));
        assert.ok(indexer.indexerDb.setBetSettled.calledWith(11, 'lost', data['BLOCK_INDEX']));
        assert.ok(indexer.indexerDb.setBetSettled.calledWith(12, 'won',  data['BLOCK_INDEX']));
        assert.strictEqual(indexer.indexerDb.setBetSettled.callCount, 3);
        assert.ok(indexer.indexerDb.setBetFeedTerminal.calledOnceWith(5, 'resolved', data['BLOCK_INDEX']));

        // One-terminal-credit-per-bet invariant: at most one credit per bettor
        const bySource = {};
        for (const c of credits) bySource[c[2]] = (bySource[c[2]] || 0) + 1;
        for (const src of [ALICE, BOB, CAROL]) assert.ok((bySource[src] || 0) <= 1, src);
    });
});

describe('BET action handler @regression @tier2', function () {
    beforeEach(function () {
        indexer = createMockIndexer();
        actionsCtx = {
            config: indexer.config,
            util: indexer.util,
            mapper: indexer.mapper,
            decoderDb: indexer.decoderDb,
            indexerDb: indexer.indexerDb,
            protocolChanges: indexer.protocolChanges,
            processAction: sinon.stub().resolves(),
        };
        handler = new Bet(actionsCtx);
        indexer.util.resetLists();

        // Wager token: 8 decimals, distinct TICK_ID (2) from the GAS token (1)
        indexer.indexerDb.getTokenInfo.resolves(createTokenInfo({ TICK: 'TEST', TICK_ID: 2, DECIMALS: 8 }));
        // Generous balances: {tick_id: amount}; 1 = GAS/XCHAIN, 2 = TEST
        indexer.indexerDb.getAddressBalances.resolves({ 1: '1000', 2: '1000' });
        // Capture ledger changes instead of writing them
        ledgerSpy = sinon.stub(indexer.util, 'processTransactionLedgerChanges').resolves();
    });

    it('W=0 resolves void: full refunds, no oracle fee', async function () {
        armWorkedExample();
        indexer.indexerDb.getOpenBetsByFeed.resolves([
            { ACTION_INDEX: 10, OUTCOME: 0, AMOUNT: '10.00000000', SOURCE: ALICE },
        ]);
        const data = createBaseData({ ACTION: 'BET', FORMAT: 3, SOURCE: ORACLE, BLOCK_TIME: T0 + 86400 + 10 });
        await handler.parse(['3', '5', '1', ''], data, null); // outcome 1 has no backers
        assert.strictEqual(data['STATUS'], 'valid');
        const [, , credits] = ledgerSpy.firstCall.args;
        assert.deepStrictEqual(credits, [['TEST', '10.00000000', ALICE]]);
        assert.ok(indexer.indexerDb.setBetFeedTerminal.calledOnceWith(5, 'resolved_void', data['BLOCK_INDEX']));
        assert.ok(indexer.indexerDb.setBetSettled.calledOnceWith(10, 'refunded', data['BLOCK_INDEX']));
    });

    it('W=T rake: a few-base-unit winning stake floors to zero, gets NO credit row, lands in dust', async function () {
        indexer.indexerDb.getBetFeedInfo.resolves(feedInfo({ FEED_STATUS: 'closed' }));
        // All money on the winner; dust bet is ONE base unit: 0.00000001 * ~0.99
        // = 9.9e-9, which floors to exactly zero at 8 decimals
        indexer.indexerDb.getOpenBetsByFeed.resolves([
            { ACTION_INDEX: 10, OUTCOME: 0, AMOUNT: '10.00000000', SOURCE: ALICE },
            { ACTION_INDEX: 11, OUTCOME: 0, AMOUNT: '0.00000001',  SOURCE: BOB },
        ]);
        const data = createBaseData({ ACTION: 'BET', FORMAT: 3, SOURCE: ORACLE, BLOCK_TIME: T0 + 86400 + 10 });
        await handler.parse(['3', '5', '0', ''], data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        const [, , credits] = ledgerSpy.firstCall.args;
        // BOB gets no credit row; his amount is absorbed into the oracle dust.
        assert.strictEqual(credits.filter(c => c[2] === BOB).length, 0);
        // BOB still transitions to won
        assert.ok(indexer.indexerDb.setBetSettled.calledWith(11, 'won', data['BLOCK_INDEX']));
        // Conservation holds: total credits == T
        const out = credits.reduce((s, c) => indexer.util.bcadd(s, c[1], 8), 0);
        assert.strictEqual(String(out), String(indexer.util.bcnum('10.00000001')));
    });
});

describe('BET action handler @regression @tier2', function () {
    beforeEach(function () {
        indexer = createMockIndexer();
        actionsCtx = {
            config: indexer.config,
            util: indexer.util,
            mapper: indexer.mapper,
            decoderDb: indexer.decoderDb,
            indexerDb: indexer.indexerDb,
            protocolChanges: indexer.protocolChanges,
            processAction: sinon.stub().resolves(),
        };
        handler = new Bet(actionsCtx);
        indexer.util.resetLists();

        // Wager token: 8 decimals, distinct TICK_ID (2) from the GAS token (1)
        indexer.indexerDb.getTokenInfo.resolves(createTokenInfo({ TICK: 'TEST', TICK_ID: 2, DECIMALS: 8 }));
        // Generous balances: {tick_id: amount}; 1 = GAS/XCHAIN, 2 = TEST
        indexer.indexerDb.getAddressBalances.resolves({ 1: '1000', 2: '1000' });
        // Capture ledger changes instead of writing them
        ledgerSpy = sinon.stub(indexer.util, 'processTransactionLedgerChanges').resolves();
    });

    it('resolve rejects: early, post-window, non-owner, out-of-range outcome', async function () {
        indexer.indexerDb.getBetFeedInfo.resolves(feedInfo());
        const early = createBaseData({ ACTION: 'BET', FORMAT: 3, SOURCE: ORACLE, BLOCK_TIME: T0 });
        await handler.parse(['3', '5', '0', ''], early, null);
        assert.strictEqual(early['STATUS'], 'invalid: FEED_ACTION_INDEX (not closed)');

        const late = createBaseData({ ACTION: 'BET', FORMAT: 3, SOURCE: ORACLE, BLOCK_TIME: T0 + 86400 + 1209600 });
        await handler.parse(['3', '5', '0', ''], late, null);
        assert.strictEqual(late['STATUS'], 'invalid: FEED_ACTION_INDEX (refund window expired)');

        const notOwner = createBaseData({ ACTION: 'BET', FORMAT: 3, SOURCE: ALICE, BLOCK_TIME: T0 + 86400 + 10 });
        await handler.parse(['3', '5', '0', ''], notOwner, null);
        assert.strictEqual(notOwner['STATUS'], 'invalid: SOURCE (not owner)');

        const badOutcome = createBaseData({ ACTION: 'BET', FORMAT: 3, SOURCE: ORACLE, BLOCK_TIME: T0 + 86400 + 10 });
        await handler.parse(['3', '5', '2', ''], badOutcome, null);
        assert.strictEqual(badOutcome['STATUS'], 'invalid: OUTCOME (range)');
    });

    it('resolve in the first deadline-crossing block (latch not yet written) is valid', async function () {
        indexer.indexerDb.getBetFeedInfo.resolves(feedInfo({ FEED_STATUS: 'open' }));
        indexer.indexerDb.getOpenBetsByFeed.resolves([]);
        const data = createBaseData({ ACTION: 'BET', FORMAT: 3, SOURCE: ORACLE, BLOCK_TIME: T0 + 86400 });
        await handler.parse(['3', '5', '0', ''], data, null);
        assert.strictEqual(data['STATUS'], 'valid');
    });
});

describe('BET action handler @regression @tier2', function () {
    beforeEach(function () {
        indexer = createMockIndexer();
        actionsCtx = {
            config: indexer.config,
            util: indexer.util,
            mapper: indexer.mapper,
            decoderDb: indexer.decoderDb,
            indexerDb: indexer.indexerDb,
            protocolChanges: indexer.protocolChanges,
            processAction: sinon.stub().resolves(),
        };
        handler = new Bet(actionsCtx);
        indexer.util.resetLists();

        // Wager token: 8 decimals, distinct TICK_ID (2) from the GAS token (1)
        indexer.indexerDb.getTokenInfo.resolves(createTokenInfo({ TICK: 'TEST', TICK_ID: 2, DECIMALS: 8 }));
        // Generous balances: {tick_id: amount}; 1 = GAS/XCHAIN, 2 = TEST
        indexer.indexerDb.getAddressBalances.resolves({ 1: '1000', 2: '1000' });
        // Capture ledger changes instead of writing them
        ledgerSpy = sinon.stub(indexer.util, 'processTransactionLedgerChanges').resolves();
    });

    it('outcome-range assertion: a stored bet outside the outcome range HALTS settlement', async function () {
        indexer.indexerDb.getBetFeedInfo.resolves(feedInfo({ FEED_STATUS: 'closed' }));
        indexer.indexerDb.getOpenBetsByFeed.resolves([
            { ACTION_INDEX: 10, OUTCOME: 5, AMOUNT: '1.00000000', SOURCE: ALICE },
        ]);
        const data = createBaseData({ ACTION: 'BET', FORMAT: 3, SOURCE: ORACLE, BLOCK_TIME: T0 + 86400 + 10 });
        await assert.rejects(
            () => handler.parse(['3', '5', '0', ''], data, null),
            /consensus-fatal/
        );
        // Nothing was credited or flipped before the halt
        assert.ok(ledgerSpy.notCalled);
        assert.ok(indexer.indexerDb.setBetFeedTerminal.notCalled);
    });
});
