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
// BET Format 2 (place) and Format 1 (cancel feed): fees, the place validation
// matrix, allow/block gating and full refunds on cancel. Part of the BET suite;
// see ../bet.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createMockIndexer, createBaseData, createTokenInfo } = require('../../../fixtures/mocks');
const { ORACLE, ALICE, BOB, CAROL, T0, feedInfo, placeData } = require('./helpers/bet_fixtures.js');

const Bet = require('../../../../src/actions/bet.js');

let indexer, actionsCtx, handler, ledgerSpy;

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

    it('place charges BET_PER_CREDIT; resolve and cancel are free', async function () {
        indexer.indexerDb.getBetFeedInfo.resolves(feedInfo());
        // Place with zero XCHAIN: fails on the per-credit gas (100 x 0.00001 = 0.001)
        indexer.indexerDb.getAddressBalances.resolves({ 1: '0', 2: '1000' });
        const p = createBaseData({ ACTION: 'BET', FORMAT: 2, SOURCE: ALICE });
        await handler.parse(['2', '5', '0', '1.0', ''], p, null);
        assert.strictEqual(p['STATUS'], 'invalid: insufficient funds (FEE)');

        // Resolve with zero XCHAIN balance: free, so it validates (owner, past deadline)
        indexer.indexerDb.getBetFeedInfo.resolves(feedInfo({ FEED_STATUS: 'closed' }));
        const r = createBaseData({ ACTION: 'BET', FORMAT: 3, SOURCE: ORACLE, BLOCK_TIME: T0 + 86400 + 10 });
        await handler.parse(['3', '5', '0', ''], r, null);
        assert.strictEqual(r['STATUS'], 'valid');

        // Cancel with zero XCHAIN balance: free
        indexer.indexerDb.getBetFeedInfo.resolves(feedInfo());
        const c = createBaseData({ ACTION: 'BET', FORMAT: 1, SOURCE: ORACLE });
        await handler.parse(['1', '5', ''], c, null);
        assert.strictEqual(c['STATUS'], 'valid');
    });

    it('accepts a valid place, escrows the stake, writes the open bet', async function () {
        indexer.indexerDb.getBetFeedInfo.resolves(feedInfo());
        const data = placeData();
        await handler.parse(['2', '5', '1', '2.50000000', ''], data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        const stored = indexer.indexerDb.createBet.firstCall.args[0];
        assert.strictEqual(stored['BET_STATUS'], 'open');
        assert.strictEqual(stored['TICK'], 'TEST'); // denormalized feed tick
        // Escrowed at parse: debit + escrow pair for the stake
        const [, , credits, debits, escrows] = ledgerSpy.firstCall.args;
        assert.deepStrictEqual(debits.filter(d => d[2] === ALICE && d[0] === 'TEST').map(d => d[1]), ['2.50000000']);
        assert.deepStrictEqual(escrows, [['TEST', '2.50000000', ALICE]]);
        assert.strictEqual(credits.filter(c => c[2] === ALICE).length, 0);
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

    const placeRejects = [
        ['unknown feed',        { feed: false },                                          ['2','5','0','1.0',''], 'invalid: FEED_ACTION_INDEX (unknown)'],
        ['feed already closed', { feed: { FEED_STATUS: 'closed' } },                      ['2','5','0','1.0',''], 'invalid: FEED_ACTION_INDEX (feed not open)'],
        ['feed cancelled',      { feed: { FEED_STATUS: 'cancelled' } },                   ['2','5','0','1.0',''], 'invalid: FEED_ACTION_INDEX (feed not open)'],
        ['clock past deadline (latch not yet written)', { feed: {}, time: T0 + 86400 },   ['2','5','0','1.0',''], 'invalid: FEED_ACTION_INDEX (closed)'],
        ['oracle self-bet',     { feed: {}, source: ORACLE },                             ['2','5','0','1.0',''], 'invalid: SOURCE (oracle may not bet own feed)'],
        ['OUTCOME out of range',{ feed: {} },                                             ['2','5','2','1.0',''], 'invalid: OUTCOME (range)'],
        ['OUTCOME negative',    { feed: {} },                                             ['2','5','-1','1.0',''], 'invalid: OUTCOME (range)'],
        ['AMOUNT zero',         { feed: {} },                                             ['2','5','0','0',''],   'invalid: AMOUNT (must be positive)'],
        ['AMOUNT below feed minimum', { feed: { MIN_AMOUNT: '5.0' } },                    ['2','5','0','1.0',''], 'invalid: AMOUNT (below feed minimum)'],
    ];
    for (const [name, setup, params, expected] of placeRejects) {
        it(`place: ${name} -> ${expected}`, async function () {
            indexer.indexerDb.getBetFeedInfo.resolves(setup.feed === false ? false : feedInfo(setup.feed));
            const data = placeData({ SOURCE: setup.source || ALICE, BLOCK_TIME: setup.time || T0 });
            await handler.parse(params, data, null);
            assert.strictEqual(data['STATUS'], expected);
        });
    }

    it('place: feed at MAX_BETS_PER_FEED rejects', async function () {
        indexer.indexerDb.getBetFeedInfo.resolves(feedInfo());
        indexer.indexerDb.countOpenBetsByFeed.resolves(indexer.config['MAX_BETS_PER_FEED']);
        const data = placeData();
        await handler.parse(['2', '5', '0', '1.0', ''], data, null);
        assert.strictEqual(data['STATUS'], 'invalid: FEED_ACTION_INDEX (feed full)');
    });

    it('place: insufficient stake balance rejects after the fee reservation', async function () {
        indexer.indexerDb.getBetFeedInfo.resolves(feedInfo());
        indexer.indexerDb.getAddressBalances.resolves({ 1: '1000', 2: '1' });
        const data = placeData();
        await handler.parse(['2', '5', '0', '2.0', ''], data, null);
        assert.strictEqual(data['STATUS'], 'invalid: insufficient funds (AMOUNT)');
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

    it('place gating: allow-then-block, BLOCK_LIST wins on both, evaluated at place time', async function () {
        // ALLOW only, member: valid
        indexer.indexerDb.getBetFeedInfo.resolves(feedInfo({ ALLOW_LIST: 70 }));
        indexer.indexerDb.getList.withArgs(70).resolves([ALICE, BOB]);
        let data = placeData();
        await handler.parse(['2', '5', '0', '1.0', ''], data, null);
        assert.strictEqual(data['STATUS'], 'valid');

        // ALLOW only, non-member: reject
        data = placeData({ SOURCE: CAROL });
        await handler.parse(['2', '5', '0', '1.0', ''], data, null);
        assert.strictEqual(data['STATUS'], 'invalid: SOURCE (not authorized)');

        // BLOCK only, listed: reject
        indexer.indexerDb.getBetFeedInfo.resolves(feedInfo({ BLOCK_LIST: 71 }));
        indexer.indexerDb.getList.withArgs(71).resolves([ALICE]);
        data = placeData();
        await handler.parse(['2', '5', '0', '1.0', ''], data, null);
        assert.strictEqual(data['STATUS'], 'invalid: SOURCE (not authorized)');

        // On BOTH lists: block wins
        indexer.indexerDb.getBetFeedInfo.resolves(feedInfo({ ALLOW_LIST: 70, BLOCK_LIST: 71 }));
        data = placeData();
        await handler.parse(['2', '5', '0', '1.0', ''], data, null);
        assert.strictEqual(data['STATUS'], 'invalid: SOURCE (not authorized)');
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

    /*****************************************************************
     * Format 1 - Cancel Feed
     ****************************************************************/

    it('cancel refunds every open bet in full with no oracle fee and works past expire_at', async function () {
        // Past expire_at on purpose: cancel has NO clock bound (spec format 1)
        indexer.indexerDb.getBetFeedInfo.resolves(feedInfo({ FEED_STATUS: 'closed' }));
        indexer.indexerDb.getOpenBetsByFeed.resolves([
            { ACTION_INDEX: 10, OUTCOME: 0, AMOUNT: '10.00000000', SOURCE: ALICE },
            { ACTION_INDEX: 11, OUTCOME: 1, AMOUNT: '5.00000000',  SOURCE: BOB },
        ]);
        const data = createBaseData({ ACTION: 'BET', FORMAT: 1, SOURCE: ORACLE, BLOCK_TIME: T0 + 99999999 });
        await handler.parse(['1', '5', ''], data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        const [, , credits, , escrows] = ledgerSpy.firstCall.args;
        assert.deepStrictEqual(credits, [['TEST', '10.00000000', ALICE], ['TEST', '5.00000000', BOB]]);
        assert.strictEqual(escrows.length, 2); // one release per bet, no fee leg
        assert.ok(indexer.indexerDb.setBetFeedTerminal.calledOnceWith(5, 'cancelled', data['BLOCK_INDEX']));
        assert.ok(indexer.indexerDb.setBetSettled.calledWith(10, 'refunded', data['BLOCK_INDEX']));
        assert.ok(indexer.indexerDb.setBetSettled.calledWith(11, 'refunded', data['BLOCK_INDEX']));
    });

    it('cancel: non-owner and terminal-status feeds reject', async function () {
        indexer.indexerDb.getBetFeedInfo.resolves(feedInfo());
        const d1 = createBaseData({ ACTION: 'BET', FORMAT: 1, SOURCE: ALICE });
        await handler.parse(['1', '5', ''], d1, null);
        assert.strictEqual(d1['STATUS'], 'invalid: SOURCE (not owner)');

        indexer.indexerDb.getBetFeedInfo.resolves(feedInfo({ FEED_STATUS: 'resolved' }));
        const d2 = createBaseData({ ACTION: 'BET', FORMAT: 1, SOURCE: ORACLE });
        await handler.parse(['1', '5', ''], d2, null);
        assert.strictEqual(d2['STATUS'], 'invalid: FEED_ACTION_INDEX (feed not open)');
    });
});
