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
// BET action handler.
// Mock-based: validation matrix for all four formats, the section-7 worked
// settlement example (exact payouts / fee / dust / conservation), the
// normative open-bet pool predicate, the zero-floor payout rule, the
// one-terminal-credit-per-bet invariant, the outcome-range halt, DETAILS
// shape enforcement, feed gating precedence, and the decision-F fee legs.
//
// This file holds Format 0 (create feed). The place, cancel, resolve and
// stored-row blocks live beside it in bet.test/, each opening the same
// 'BET action handler @regression @tier2' describe so every full test title is
// unchanged; bet.test/helpers/bet_fixtures.js holds the addresses and wire
// builders they share.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createMockIndexer, createBaseData, createTokenInfo } = require('../../fixtures/mocks');
const { ORACLE, T0, makeCreateParams, b64 } = require('./bet.test/helpers/bet_fixtures.js');

const Bet = require('../../../src/actions/bet/index.js');

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
     * Format 0 - Create Feed
     ****************************************************************/

    it('accepts a minimal valid create and stores the open feed', async function () {
        const data = createBaseData({ ACTION: 'BET', FORMAT: 0, SOURCE: ORACLE });
        await handler.parse(makeCreateParams(), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        assert.ok(indexer.indexerDb.createBetFeed.calledOnce);
        const stored = indexer.indexerDb.createBetFeed.firstCall.args[0];
        assert.strictEqual(stored['FEED_STATUS'], 'open');
        // expire_at materialized = deadline + defaulted window
        assert.strictEqual(String(stored['EXPIRE_AT']), String(T0 + 86400 + indexer.config['DEFAULT_BET_REFUND_WINDOW']));
        // open history row caused by the create itself
        assert.ok(indexer.indexerDb.createBetFeedStatus.calledOnceWith(data['ACTION_INDEX'], data['ACTION_INDEX'], 'open'));
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

    it('canonicalizes OUTCOMES (trims labels, joins with single commas)', async function () {
        const data = createBaseData({ ACTION: 'BET', FORMAT: 0, SOURCE: ORACLE });
        await handler.parse(makeCreateParams({ OUTCOMES: ' yes , no ' }), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        assert.strictEqual(indexer.indexerDb.createBetFeed.firstCall.args[0]['OUTCOMES'], 'yes,no');
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

    const createRejects = [
        ['empty LABEL',              { LABEL: '' },                              'invalid: LABEL (length)'],
        ['oversize LABEL',           { LABEL: 'x'.repeat(251) },                 'invalid: LABEL (length)'],
        ['one outcome',              { OUTCOMES: 'yes' },                        'invalid: OUTCOMES (count)'],
        ['17 outcomes',              { OUTCOMES: Array.from({length:17},(_,i)=>'o'+i).join(',') }, 'invalid: OUTCOMES (count)'],
        ['empty outcome label',      { OUTCOMES: 'yes,, no' },                   'invalid: OUTCOMES (label)'],
        ['oversize outcome label',   { OUTCOMES: 'yes,' + 'x'.repeat(65) },      'invalid: OUTCOMES (label)'],
        ['control char in label',    { OUTCOMES: 'yes,n\to' },                 'invalid: OUTCOMES (label)'],
        ['duplicate labels',         { OUTCOMES: 'yes,yes' },                    'invalid: OUTCOMES (duplicate)'],
        ['case variants coexist (allowed)', { OUTCOMES: 'Yes,yes' },             null],
        ['empty TICK = native coin', { TICK: '' },                               'invalid: TICK (native coin not supported)'],
        ['FEE 3 decimals',           { FEE: '1.005' },                           'invalid: FEE (format)'],
        ['FEE negative',             { FEE: '-1' },                              'invalid: FEE (format)'],
        ['FEE above max',            { FEE: '10.01' },                           'invalid: FEE (range)'],
        ['DEADLINE missing',         { DEADLINE: '' },                           'invalid: DEADLINE (format)'],
        ['DEADLINE in the past',     { DEADLINE: String(T0 - 1) },               'invalid: DEADLINE (past)'],
        ['DEADLINE at BLOCK_TIME',   { DEADLINE: String(T0) },                   'invalid: DEADLINE (past)'],
        ['DEADLINE beyond horizon',  { DEADLINE: String(T0 + 31536000 + 1) },    'invalid: DEADLINE (too far)'],
        ['REFUND_WINDOW below min',  { REFUND_WINDOW: '3599' },                  'invalid: REFUND_WINDOW (range)'],
        ['REFUND_WINDOW above max',  { REFUND_WINDOW: '31536001' },              'invalid: REFUND_WINDOW (range)'],
        ['MIN_AMOUNT zero',          { MIN_AMOUNT: '0' },                        'invalid: MIN_AMOUNT (format)'],
        ['MEMO with pipe is unreachable on the wire but rejected in depth', { MEMO: 'a|b' }, 'invalid: MEMO (pipe)'],
    ];
    for (const [name, over, expected] of createRejects) {
        it(`create: ${name}${expected ? ' -> ' + expected : ''}`, async function () {
            const data = createBaseData({ ACTION: 'BET', FORMAT: 0, SOURCE: ORACLE });
            await handler.parse(makeCreateParams(over), data, null);
            assert.strictEqual(data['STATUS'], expected === null ? 'valid' : expected);
        });
    }
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

    it('create: unknown TICK rejects', async function () {
        indexer.indexerDb.getTokenInfo.resolves(null);
        const data = createBaseData({ ACTION: 'BET', FORMAT: 0, SOURCE: ORACLE });
        await handler.parse(makeCreateParams(), data, null);
        assert.strictEqual(data['STATUS'], 'invalid: TICK (unknown)');
    });

    it('create: trade-controller-bound TICK rejects (v0)', async function () {
        indexer.indexerDb.getEffectiveTokenControllerForGuard.resolves({ contract_index: 9 });
        const data = createBaseData({ ACTION: 'BET', FORMAT: 0, SOURCE: ORACLE });
        await handler.parse(makeCreateParams(), data, null);
        assert.strictEqual(data['STATUS'], 'invalid: TICK (controller-bound)');
    });

    it('create: ALLOW_LIST unknown / unsupported type / equal lists reject', async function () {
        const data1 = createBaseData({ ACTION: 'BET', FORMAT: 0, SOURCE: ORACLE });
        indexer.indexerDb.getListType.resolves(false);
        await handler.parse(makeCreateParams({ ALLOW_LIST: '77' }), data1, null);
        assert.strictEqual(data1['STATUS'], 'invalid: ALLOW_LIST (unknown)');

        const data2 = createBaseData({ ACTION: 'BET', FORMAT: 0, SOURCE: ORACLE });
        indexer.indexerDb.getListType.resolves(1); // tick list, not address
        await handler.parse(makeCreateParams({ ALLOW_LIST: '77' }), data2, null);
        assert.strictEqual(data2['STATUS'], 'invalid: ALLOW_LIST (unsupported)');

        const data3 = createBaseData({ ACTION: 'BET', FORMAT: 0, SOURCE: ORACLE });
        indexer.indexerDb.getListType.resolves(2);
        await handler.parse(makeCreateParams({ ALLOW_LIST: '77', BLOCK_LIST: '77' }), data3, null);
        assert.strictEqual(data3['STATUS'], 'invalid: BLOCK_LIST (same as ALLOW_LIST)');
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

    it('create: valid DETAILS with matching outcomes accepted', async function () {
        const data = createBaseData({ ACTION: 'BET', FORMAT: 0, SOURCE: ORACLE });
        await handler.parse(makeCreateParams({ DETAILS: b64({ title: 'T', outcomes: ['yes', 'no'] }) }), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
    });

    const detailsRejects = [
        ['non-base64 charset',   'not_base64!',                          'invalid: DETAILS (format)'],
        ['bad padding length',   'abcde',                                'invalid: DETAILS (format)'],
        ['non-canonical base64', 'ab==',                                 'invalid: DETAILS (format)'],
        ['non-JSON payload',     Buffer.from('hello').toString('base64'), 'invalid: DETAILS (json)'],
        ['top-level array',      Buffer.from('[1,2]').toString('base64'), 'invalid: DETAILS (json shape)'],
        ['top-level scalar',     Buffer.from('42').toString('base64'),    'invalid: DETAILS (json shape)'],
    ];
    for (const [name, details, expected] of detailsRejects) {
        it(`create DETAILS: ${name} -> ${expected}`, async function () {
            const data = createBaseData({ ACTION: 'BET', FORMAT: 0, SOURCE: ORACLE });
            await handler.parse(makeCreateParams({ DETAILS: details }), data, null);
            assert.strictEqual(data['STATUS'], expected);
        });
    }

    it('create DETAILS: nesting past MAX_BET_DETAILS_DEPTH rejects', async function () {
        let node = {};
        const root = node;
        for (let i = 0; i < indexer.config['MAX_BET_DETAILS_DEPTH'] + 1; i++) node = node.n = {};
        const data = createBaseData({ ACTION: 'BET', FORMAT: 0, SOURCE: ORACLE });
        await handler.parse(makeCreateParams({ DETAILS: b64(root) }), data, null);
        assert.strictEqual(data['STATUS'], 'invalid: DETAILS (json shape)');
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

    it('create DETAILS: outcomes mismatch (order, count, non-array) rejects', async function () {
        for (const bad of [ { outcomes: ['no', 'yes'] }, { outcomes: ['yes'] }, { outcomes: 'yes,no' } ]) {
            const data = createBaseData({ ACTION: 'BET', FORMAT: 0, SOURCE: ORACLE });
            await handler.parse(makeCreateParams({ DETAILS: b64(bad) }), data, null);
            assert.strictEqual(data['STATUS'], 'invalid: DETAILS (outcomes mismatch)', JSON.stringify(bad));
        }
    });

    it('create DETAILS: oversize decoded payload rejects', async function () {
        const big = { pad: 'x'.repeat(indexer.config['MAX_BET_DETAILS_LENGTH']) };
        const data = createBaseData({ ACTION: 'BET', FORMAT: 0, SOURCE: ORACLE });
        await handler.parse(makeCreateParams({ DETAILS: b64(big) }), data, null);
        assert.strictEqual(data['STATUS'], 'invalid: DETAILS (length)');
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
     * Decision-F fees
     ****************************************************************/

    it('create inside the free window charges zero; past it charges per-day on expire_at', async function () {
        // 30d deadline + 14d default window = 44d: free
        const data1 = createBaseData({ ACTION: 'BET', FORMAT: 0, SOURCE: ORACLE });
        await handler.parse(makeCreateParams({ DEADLINE: String(T0 + 30 * 86400) }), data1, null);
        assert.strictEqual(data1['STATUS'], 'valid');

        // 351d deadline + 14d window = 365d: 275 chargeable days x 550 x 0.00001 = 1.5125
        // Prove the charge is real by starving the XCHAIN balance below it
        indexer.indexerDb.getAddressBalances.resolves({ 1: '1.51', 2: '1000' });
        const data2 = createBaseData({ ACTION: 'BET', FORMAT: 0, SOURCE: ORACLE });
        await handler.parse(makeCreateParams({ DEADLINE: String(T0 + 351 * 86400) }), data2, null);
        assert.strictEqual(data2['STATUS'], 'invalid: insufficient funds (FEE)');
        indexer.indexerDb.getAddressBalances.resolves({ 1: '1.52', 2: '1000' });
        const data3 = createBaseData({ ACTION: 'BET', FORMAT: 0, SOURCE: ORACLE });
        await handler.parse(makeCreateParams({ DEADLINE: String(T0 + 351 * 86400) }), data3, null);
        assert.strictEqual(data3['STATUS'], 'valid');
    });
});
