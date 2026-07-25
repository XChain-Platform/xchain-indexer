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
// BET action handler (spec claude/specs/BETTING_SYSTEM_SPEC.md,  P4).
// Mock-based: validation matrix for all four formats, the section-7 worked
// settlement example (exact payouts / fee / dust / conservation), the
// normative open-bet pool predicate, the zero-floor payout rule, the
// one-terminal-credit-per-bet invariant, the outcome-range halt, DETAILS
// shape enforcement, feed gating precedence, and the decision-F fee legs.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createMockIndexer, createBaseData, createTokenInfo } = require('../../fixtures/mocks');

const Bet = require('../../../src/actions/bet.js');

const ORACLE = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const ALICE  = 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM';
const BOB    = 'mzBc4XEFSdzCDcTxAgf6EZXgsZWpztRhef';
const CAROL  = 'mqPXTX9BpNzHmB3rd94xhk3SLZBjWK5B7c';

const T0 = 1700000000; // base BLOCK_TIME

describe('BET action handler @regression @tier2', function () {

    let indexer, actionsCtx, handler, ledgerSpy;

    // A live feed dict as getBetFeedInfo returns it
    function feedInfo(overrides = {}) {
        return {
            ACTION_INDEX: 5,
            SOURCE: ORACLE,
            LABEL: 'Test market',
            OUTCOMES: 'yes,no',
            TICK: 'TEST',
            FEE: '1.00',
            DEADLINE: T0 + 86400,
            REFUND_WINDOW: 1209600,
            EXPIRE_AT: T0 + 86400 + 1209600,
            MIN_AMOUNT: null,
            ALLOW_LIST: null,
            BLOCK_LIST: null,
            FEED_STATUS: 'open',
            CLOSED_BLOCK: null,
            TERMINAL_BLOCK: null,
            ...overrides,
        };
    }

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

    function makeCreateParams(over = {}) {
        const p = {
            LABEL: 'Test market', OUTCOMES: 'yes,no', TICK: 'TEST', FEE: '1.00',
            DEADLINE: String(T0 + 86400), REFUND_WINDOW: '', MIN_AMOUNT: '',
            ALLOW_LIST: '', BLOCK_LIST: '', DETAILS: '', MEMO: '',
            ...over,
        };
        return ['0', p.LABEL, p.OUTCOMES, p.TICK, p.FEE, p.DEADLINE, p.REFUND_WINDOW,
                p.MIN_AMOUNT, p.ALLOW_LIST, p.BLOCK_LIST, p.DETAILS, p.MEMO];
    }

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

    it('canonicalizes OUTCOMES (trims labels, joins with single commas)', async function () {
        const data = createBaseData({ ACTION: 'BET', FORMAT: 0, SOURCE: ORACLE });
        await handler.parse(makeCreateParams({ OUTCOMES: ' yes , no ' }), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        assert.strictEqual(indexer.indexerDb.createBetFeed.firstCall.args[0]['OUTCOMES'], 'yes,no');
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

    /*****************************************************************
     * DETAILS validation
     ****************************************************************/

    function b64(obj){ return Buffer.from(JSON.stringify(obj)).toString('base64'); }

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

    /*****************************************************************
     * Format 2 - Place Bet
     ****************************************************************/

    function placeData(over = {}) {
        return createBaseData({ ACTION: 'BET', FORMAT: 2, SOURCE: ALICE, ...over });
    }

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
