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
// BET cancel and resolve leg rows: what bet_cancels and bet_resolves store for
// valid and rejected legs, and that the leg tables are not cross-wired. Part of
// the BET suite; see ../bet.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createMockIndexer, createBaseData, createTokenInfo } = require('../../../fixtures/mocks');
const { ORACLE, ALICE, T0, feedInfo, makeCreateParams } = require('./helpers/bet_fixtures.js');

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

    /*****************************************************************
     * The cancel (1) and resolve (3) legs persist a parse status
     *
     * Without these rows neither leg writes a typed row at all: its only durable
     * trace is a bet_feed_statuses history row, and that is written ONLY on the valid
     * path. A chain-REJECTED cancel or resolve would therefore leave no status
     * anywhere, the explorer would serve the action with a NULL status, and the SDK
     * could only report statusKnown:false / statusSource:assumed rather than a real
     * verdict.
     * The rule these tests pin: one row per leg, written WHATEVER the status, the
     * same house convention create (bet_feeds) and place (bets) already follow.
     ****************************************************************/

    it('cancel stores a bet_cancels row with the valid parse status and the feed it targeted', async function () {
        indexer.indexerDb.getBetFeedInfo.resolves(feedInfo());
        indexer.indexerDb.getOpenBetsByFeed.resolves([]);
        const data = createBaseData({ ACTION: 'BET', FORMAT: 1, SOURCE: ORACLE, ACTION_INDEX: 77 });
        await handler.parse(['1', '5', 'bye'], data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        assert.ok(indexer.indexerDb.createBetCancel.calledOnce);
        const row = indexer.indexerDb.createBetCancel.firstCall.args[0];
        assert.strictEqual(row['ACTION_INDEX'], 77);
        assert.strictEqual(Number(row['FEED_ACTION_INDEX']), 5);
        assert.strictEqual(row['STATUS'], 'valid');
        assert.strictEqual(row['MEMO'], 'bye');
        // The resolve leg's table is untouched by a cancel
        assert.ok(indexer.indexerDb.createBetResolve.notCalled);
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

    it('a REJECTED cancel still stores its row, carrying the rejection reason', async function () {
        indexer.indexerDb.getBetFeedInfo.resolves(feedInfo());
        const data = createBaseData({ ACTION: 'BET', FORMAT: 1, SOURCE: ALICE, ACTION_INDEX: 78 });
        await handler.parse(['1', '5', ''], data, null);
        assert.strictEqual(data['STATUS'], 'invalid: SOURCE (not owner)');
        assert.ok(indexer.indexerDb.createBetCancel.calledOnce,
            'a rejected cancel must persist a row; with none the API can only ASSUME it succeeded');
        assert.strictEqual(indexer.indexerDb.createBetCancel.firstCall.args[0]['STATUS'], 'invalid: SOURCE (not owner)');
        // Rejected means rejected: no refunds, no terminal flip, no lifecycle history row
        assert.ok(ledgerSpy.notCalled);
        assert.ok(indexer.indexerDb.setBetFeedTerminal.notCalled);
        assert.ok(indexer.indexerDb.createBetFeedStatus.notCalled);
    });

    it('a cancel naming a feed that does not exist still stores its row and its feed ref', async function () {
        // getBetFeedInfo defaults to false (unknown feed), so nothing constrains the
        // stored FEED_ACTION_INDEX but the wire value itself
        const data = createBaseData({ ACTION: 'BET', FORMAT: 1, SOURCE: ORACLE, ACTION_INDEX: 79 });
        await handler.parse(['1', '4242', ''], data, null);
        assert.strictEqual(data['STATUS'], 'invalid: FEED_ACTION_INDEX (unknown)');
        const row = indexer.indexerDb.createBetCancel.firstCall.args[0];
        assert.strictEqual(Number(row['FEED_ACTION_INDEX']), 4242);
        assert.strictEqual(row['STATUS'], 'invalid: FEED_ACTION_INDEX (unknown)');
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

    it('resolve stores a bet_resolves row with the claimed outcome and the valid status', async function () {
        indexer.indexerDb.getBetFeedInfo.resolves(feedInfo({ FEED_STATUS: 'closed' }));
        indexer.indexerDb.getOpenBetsByFeed.resolves([]);
        const data = createBaseData({ ACTION: 'BET', FORMAT: 3, SOURCE: ORACLE, BLOCK_TIME: T0 + 86400 + 10, ACTION_INDEX: 80 });
        await handler.parse(['3', '5', '1', 'called it'], data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        assert.ok(indexer.indexerDb.createBetResolve.calledOnce);
        const row = indexer.indexerDb.createBetResolve.firstCall.args[0];
        assert.strictEqual(row['ACTION_INDEX'], 80);
        assert.strictEqual(Number(row['FEED_ACTION_INDEX']), 5);
        assert.strictEqual(Number(row['OUTCOME']), 1);
        assert.strictEqual(row['STATUS'], 'valid');
        assert.strictEqual(row['MEMO'], 'called it');
        assert.ok(indexer.indexerDb.createBetCancel.notCalled);
    });

    it('a REJECTED resolve still stores its row, carrying the rejection reason', async function () {
        indexer.indexerDb.getBetFeedInfo.resolves(feedInfo());
        // Out of the feed's 0..1 outcome range
        const data = createBaseData({ ACTION: 'BET', FORMAT: 3, SOURCE: ORACLE, BLOCK_TIME: T0 + 86400 + 10, ACTION_INDEX: 81 });
        await handler.parse(['3', '5', '2', ''], data, null);
        assert.strictEqual(data['STATUS'], 'invalid: OUTCOME (range)');
        assert.ok(indexer.indexerDb.createBetResolve.calledOnce,
            'a rejected resolve must persist a row; with none the API can only ASSUME it succeeded');
        const row = indexer.indexerDb.createBetResolve.firstCall.args[0];
        assert.strictEqual(row['STATUS'], 'invalid: OUTCOME (range)');
        // The claimed outcome is stored as audit data and settles nothing
        assert.strictEqual(Number(row['OUTCOME']), 2);
        assert.ok(ledgerSpy.notCalled);
        assert.ok(indexer.indexerDb.setBetFeedTerminal.notCalled);
        assert.ok(indexer.indexerDb.setBetSettled.notCalled);
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

    it('the leg tables are not cross-wired: create and place write neither', async function () {
        const create = createBaseData({ ACTION: 'BET', FORMAT: 0, SOURCE: ORACLE });
        await handler.parse(makeCreateParams(), create, null);
        assert.strictEqual(create['STATUS'], 'valid');

        indexer.indexerDb.getBetFeedInfo.resolves(feedInfo());
        const place = createBaseData({ ACTION: 'BET', FORMAT: 2, SOURCE: ALICE, BLOCK_TIME: T0, ACTION_INDEX: 82 });
        await handler.parse(['2', '5', '0', '1.00000000', ''], place, null);
        assert.strictEqual(place['STATUS'], 'valid');

        assert.ok(indexer.indexerDb.createBetCancel.notCalled);
        assert.ok(indexer.indexerDb.createBetResolve.notCalled);
    });
});
