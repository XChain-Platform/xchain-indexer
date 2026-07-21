// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.
//
// Public validity-first pre-flight  unit suite. Exercises the
// REAL computePreflight prototype with the dry-run engine stubbed
// (the engine itself is unit-tested in feeQuoteDryRun.test.js): the
// classification (deny/exempt/quotable), FEE_DESTINATION decoupling,
// guardInert surfacing, admission cap, and the height-keyed memo.

const assert = require('assert');

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const Utility       = require('../../src/utility.js');
const Actions       = require('../../src/actions.js');
const PreflightMemo = require('../../src/preflightMemo.js');

const FEE_DEST    = 'feeDestinationAddr111111111111111';
const PLACEHOLDER = 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

function makeUtil(coin, feeDestination){
    let util = new Utility();
    util.config['COIN']    = coin;
    util.config['ADDRESS'] = Object.assign({}, util.config['ADDRESS'] || {}, { FEE_DESTINATION: feeDestination });
    return util;
}

function makeCtx(util, { dryRun, blockIndex = 100 } = {}){
    let calls = { dryRuns: 0, lastArgs: null };
    let ctx = {
        config:    util.config,
        util:      util,
        indexerDb: { getLatestBlockIndex: async () => blockIndex, getBlockTime: async () => 1000 },
        actionAliases: { TRANSFER: 'SEND', ADDR: 'ADDRESS', DROP: 'AIRDROP', CAST: 'BROADCAST', MSG: 'MESSAGE' },
        _preflightMemo: new PreflightMemo(4),
        _feeQuotePending: 0,
        _calls: calls,
        _dryRunAction: async (args) => {
            calls.dryRuns++;
            calls.lastArgs = args;
            return Object.assign({ blockIndex, blockTime: 1000, status: 'valid', error: null, xchainFee: '0' }, dryRun || {});
        },
        computePreflight: Actions.prototype.computePreflight
    };
    return { ctx, calls };
}

describe('public pre-flight (computePreflight) @regression @tier1', function () {

    describe('classification', function () {
        it('quotable action returns a validity verdict', async function () {
            let { ctx } = makeCtx(makeUtil('BTC', FEE_DEST));
            let r = await ctx.computePreflight({ action: 'SEND', params: '0|JDOG|1|addr' });
            assert.strictEqual(r.supported, true);
            assert.strictEqual(r.valid, true);
            assert.strictEqual(r.status, 'valid');
            assert.strictEqual(r.feeExempt, false);
        });

        it('VM actions stay denylisted (never run the engine)', async function () {
            let { ctx, calls } = makeCtx(makeUtil('BTC', FEE_DEST));
            for(const a of ['DEPLOY', 'EXECUTE', 'XEXEC', 'BATCH']){
                let r = await ctx.computePreflight({ action: a, params: '0|x' });
                assert.strictEqual(r.supported, false, a + ' supported');
                assert.strictEqual(r.denied, true, a + ' denied');
                assert.strictEqual(r.valid, null, a + ' valid');
            }
            assert.strictEqual(calls.dryRuns, 0, 'denied actions must not run the dry-run');
        });

        it('settlement/lifecycle actions are feeExempt with no fake verdict', async function () {
            let { ctx, calls } = makeCtx(makeUtil('BTC', FEE_DEST));
            let r = await ctx.computePreflight({ action: 'COINPAY', params: '0|42' });
            assert.strictEqual(r.supported, false);
            assert.strictEqual(r.feeExempt, true);
            assert.strictEqual(r.valid, null, 'feeExempt must NOT claim valid (COINPAY false-PASS trap)');
            assert.strictEqual(calls.dryRuns, 0);
        });

        it('aliases resolve before classification', async function () {
            let { ctx } = makeCtx(makeUtil('BTC', FEE_DEST));
            let r = await ctx.computePreflight({ action: 'TRANSFER', params: '0|JDOG|1|addr' });
            assert.strictEqual(r.action, 'SEND');
        });
    });

    describe('FEE_DESTINATION decoupling (the  fix)', function () {
        it('reports a verdict even when no FEE_DESTINATION is configured', async function () {
            let { ctx } = makeCtx(makeUtil('BTC', PLACEHOLDER));
            let r = await ctx.computePreflight({ action: 'SEND', params: '0|JDOG|1|addr' });
            // computeFeeQuote would return supported:false here; pre-flight must not.
            assert.strictEqual(r.supported, true);
            assert.strictEqual(r.valid, true);
        });

        it('passes the probe fee destination when one IS configured', async function () {
            let { ctx, calls } = makeCtx(makeUtil('BTC', FEE_DEST));
            await ctx.computePreflight({ action: 'SEND', params: '0|JDOG|1|addr' });
            assert.strictEqual(calls.lastArgs.probeFeeDestination, FEE_DEST);
            assert.strictEqual(calls.lastArgs.guardInert, true);
        });
    });

    describe('invalid verdict', function () {
        it('surfaces the handler status/error verbatim', async function () {
            let { ctx } = makeCtx(makeUtil('BTC', FEE_DEST), { dryRun: { status: 'insufficient_balance', error: 'balance too low' } });
            let r = await ctx.computePreflight({ action: 'SEND', params: '0|JDOG|999|addr' });
            assert.strictEqual(r.valid, false);
            assert.strictEqual(r.status, 'insufficient_balance');
            assert.strictEqual(r.error, 'balance too low');
        });
    });

    describe('guardInert surfacing', function () {
        it('a controller-guard-refused verdict sets guardInert:true and valid:null', async function () {
            let { ctx } = makeCtx(makeUtil('BTC', FEE_DEST), { dryRun: { status: 'FEE_QUOTE_CONTROLLER_UNSUPPORTED' } });
            let r = await ctx.computePreflight({ action: 'SEND', params: '0|CTRL|1|addr' });
            assert.strictEqual(r.guardInert, true);
            assert.strictEqual(r.valid, null, 'guard-inert verdict is not trustworthy; valid must be null');
        });
    });

    describe('admission cap', function () {
        it('returns busy/retryable when the pending window is full', async function () {
            let { ctx } = makeCtx(makeUtil('BTC', FEE_DEST));
            ctx._feeQuotePending = 8;
            let r = await ctx.computePreflight({ action: 'SEND', params: '0|JDOG|1|addr' });
            assert.strictEqual(r.busy, true);
            assert.strictEqual(r.retryable, true);
        });
    });

    describe('height-keyed verdict memo', function () {
        it('serves an identical same-height re-run from cache (no second dry-run)', async function () {
            let { ctx, calls } = makeCtx(makeUtil('BTC', FEE_DEST), { blockIndex: 500 });
            let a = await ctx.computePreflight({ action: 'SEND', params: '0|JDOG|1|addr', source: 's' });
            let b = await ctx.computePreflight({ action: 'SEND', params: '0|JDOG|1|addr', source: 's' });
            assert.strictEqual(calls.dryRuns, 1, 'second identical call must hit the memo');
            assert.strictEqual(a.valid, b.valid);
            assert.strictEqual(b.cached, true);
        });

        it('a new tip changes the key (fresh dry-run)', async function () {
            let util = makeUtil('BTC', FEE_DEST);
            let { ctx, calls } = makeCtx(util);
            let height = 100;
            ctx.indexerDb.getLatestBlockIndex = async () => height;
            await ctx.computePreflight({ action: 'SEND', params: '0|JDOG|1|addr', source: 's' });
            height = 101; // a block landed
            await ctx.computePreflight({ action: 'SEND', params: '0|JDOG|1|addr', source: 's' });
            assert.strictEqual(calls.dryRuns, 2, 'a new tip must not be served stale');
        });

        it('a different source is a distinct verdict', async function () {
            let { ctx, calls } = makeCtx(makeUtil('BTC', FEE_DEST), { blockIndex: 500 });
            await ctx.computePreflight({ action: 'SEND', params: '0|JDOG|1|addr', source: 'alice' });
            await ctx.computePreflight({ action: 'SEND', params: '0|JDOG|1|addr', source: 'bob' });
            assert.strictEqual(calls.dryRuns, 2);
        });
    });
});
