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
            return Object.assign({ blockIndex, blockTime: 1000, status: 'valid', error: null,
                                   xchainFee: '0', sourceFeeBalance: null }, dryRun || {});
        },
        _nativeFeeMandatory: Actions.prototype._nativeFeeMandatory,
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

        it('passes the probe fee destination on the NATIVE settlement path', async function () {
            let { ctx, calls } = makeCtx(makeUtil('BTC', FEE_DEST));
            await ctx.computePreflight({ action: 'SEND', params: '0|JDOG|1|addr', feeMode: 'native' });
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

    describe('fee echo ', function () {
        it('echoes the dry-run xchainFee, 8dp normalized, so no second round-trip is needed', async function () {
            let { ctx, calls } = makeCtx(makeUtil('BTC', FEE_DEST), { dryRun: { xchainFee: '0.5' } });
            let r = await ctx.computePreflight({ action: 'ISSUE', params: '0|NEWTICK' });
            assert.strictEqual(r.xchainFee, '0.50000000');
            assert.strictEqual(calls.dryRuns, 1, 'the fee must come from the SAME dry-run, not an extra one');
        });

        it('a valid zero-fee action reports 0.00000000, not null', async function () {
            let { ctx } = makeCtx(makeUtil('BTC', FEE_DEST), { dryRun: { xchainFee: '0' } });
            let r = await ctx.computePreflight({ action: 'SEND', params: '0|JDOG|1|addr' });
            assert.strictEqual(r.xchainFee, '0.00000000');
        });

        it('reports null when the run never staged a fee record', async function () {
            let { ctx } = makeCtx(makeUtil('BTC', FEE_DEST), { dryRun: { status: 'insufficient_balance', error: 'balance too low', xchainFee: null } });
            let r = await ctx.computePreflight({ action: 'SEND', params: '0|JDOG|999|addr' });
            assert.strictEqual(r.valid, false);
            assert.strictEqual(r.xchainFee, null);
        });

        it('an invalid verdict still echoes a fee the handler did stage', async function () {
            let { ctx } = makeCtx(makeUtil('BTC', FEE_DEST), { dryRun: { status: 'invalid_fee', error: 'fee output too small', xchainFee: '0.001' } });
            let r = await ctx.computePreflight({ action: 'DIVIDEND', params: '0|JDOG|XCP|1' });
            assert.strictEqual(r.valid, false);
            assert.strictEqual(r.xchainFee, '0.00100000');
        });

        it('is echoed with no FEE_DESTINATION configured (XCHAIN-mode disclosure is fee-destination independent)', async function () {
            let { ctx, calls } = makeCtx(makeUtil('BTC', PLACEHOLDER), { dryRun: { xchainFee: '1.25' } });
            let r = await ctx.computePreflight({ action: 'ISSUE', params: '0|NEWTICK' });
            assert.strictEqual(calls.lastArgs.probeFeeDestination, null, 'no probe output without a fee destination');
            assert.strictEqual(r.xchainFee, '1.25000000');
        });

        it('survives the height-keyed memo (a cached verdict still carries the fee)', async function () {
            let { ctx, calls } = makeCtx(makeUtil('BTC', FEE_DEST), { blockIndex: 500, dryRun: { xchainFee: '2' } });
            await ctx.computePreflight({ action: 'ISSUE', params: '0|NEWTICK', source: 's' });
            let b = await ctx.computePreflight({ action: 'ISSUE', params: '0|NEWTICK', source: 's' });
            assert.strictEqual(calls.dryRuns, 1);
            assert.strictEqual(b.cached, true);
            assert.strictEqual(b.xchainFee, '2.00000000');
        });

        it('no-verdict responses carry no fee field (nothing was dry-run)', async function () {
            let { ctx } = makeCtx(makeUtil('BTC', FEE_DEST));
            let denied = await ctx.computePreflight({ action: 'DEPLOY', params: '0|x' });
            let exempt = await ctx.computePreflight({ action: 'COINPAY', params: '0|42' });
            assert.strictEqual(denied.xchainFee, undefined);
            assert.strictEqual(exempt.xchainFee, undefined);
        });
    });

    // : the dry-run used to inject the probe fee output unconditionally, which put every
    // pre-flight in NATIVE settlement mode and so never debited the protocol fee against the
    // payer's XCHAIN balance. A payer holding zero XCHAIN got valid:true, signed, paid a miner
    // fee, and the chain then indexed the action `invalid: insufficient funds (FEE)`.
    describe('fee settlement mode + payer balance ', function () {

        it('BTC defaults to the XCHAIN debit: no probe output, so the handler checks the balance', async function () {
            let { ctx, calls } = makeCtx(makeUtil('BTC', FEE_DEST));
            let r = await ctx.computePreflight({ action: 'ISSUE', params: '0|NEWTICK', source: 'payer' });
            assert.strictEqual(calls.lastArgs.probeFeeDestination, null,
                'a probe output would exempt the dry-run from the XCHAIN fee debit');
            assert.strictEqual(r.feeMode, 'xchain');
        });

        it('a mandatory-native chain still probes (LTC/DOGE have no XCHAIN fee lane)', async function () {
            for(const coin of ['LTC', 'DOGE']){
                let { ctx, calls } = makeCtx(makeUtil(coin, FEE_DEST));
                let r = await ctx.computePreflight({ action: 'ISSUE', params: '0|NEWTICK', source: 'payer' });
                assert.strictEqual(calls.lastArgs.probeFeeDestination, FEE_DEST, coin + ' probe');
                assert.strictEqual(r.feeMode, 'native', coin + ' mode');
            }
        });

        it('an explicit feeMode is honored in both directions', async function () {
            let btc = makeCtx(makeUtil('BTC', FEE_DEST));
            let rn  = await btc.ctx.computePreflight({ action: 'ISSUE', params: '0|NEWTICK', feeMode: 'NATIVE' });
            assert.strictEqual(rn.feeMode, 'native', 'case-insensitive');
            assert.strictEqual(btc.calls.lastArgs.probeFeeDestination, FEE_DEST);

            let doge = makeCtx(makeUtil('DOGE', FEE_DEST));
            let rx   = await doge.ctx.computePreflight({ action: 'ISSUE', params: '0|NEWTICK', feeMode: 'xchain' });
            assert.strictEqual(rx.feeMode, 'xchain');
            assert.strictEqual(doge.calls.lastArgs.probeFeeDestination, null);
        });

        it('an unusable FEE_DESTINATION falls back to the XCHAIN debit, as the chain does', async function () {
            let { ctx, calls } = makeCtx(makeUtil('DOGE', PLACEHOLDER));
            let r = await ctx.computePreflight({ action: 'ISSUE', params: '0|NEWTICK', feeMode: 'native' });
            assert.strictEqual(r.feeMode, 'xchain');
            assert.strictEqual(calls.lastArgs.probeFeeDestination, null);
        });

        it('an unrecognized feeMode falls back to the chain default rather than guessing', async function () {
            let { ctx } = makeCtx(makeUtil('BTC', FEE_DEST));
            let r = await ctx.computePreflight({ action: 'ISSUE', params: '0|NEWTICK', feeMode: 'gas' });
            assert.strictEqual(r.feeMode, 'xchain');
        });

        it('the insufficient-fee verdict now reaches the caller verbatim (the live failure)', async function () {
            let { ctx } = makeCtx(makeUtil('BTC', FEE_DEST), { dryRun: {
                status: 'invalid: insufficient funds (FEE)', error: null,
                xchainFee: '0.50000000', sourceFeeBalance: '0' } });
            let r = await ctx.computePreflight({ action: 'ISSUE', params: '0|S22NOGAS', source: 'brokePayer' });
            assert.strictEqual(r.valid, false, 'a payer with no XCHAIN must NOT be told valid');
            assert.strictEqual(r.error, 'invalid: insufficient funds (FEE)');
        });

        it('asks the dry-run for the payer balance in the fee token', async function () {
            let { ctx, calls } = makeCtx(makeUtil('BTC', FEE_DEST));
            let r = await ctx.computePreflight({ action: 'ISSUE', params: '0|NEWTICK', source: 'payer' });
            assert.strictEqual(calls.lastArgs.feeBalanceTick, 'XCHAIN');
            assert.strictEqual(r.feeTick, 'XCHAIN');
        });

        it('reports the payer balance beside the fee, 8dp, with affordability', async function () {
            let { ctx } = makeCtx(makeUtil('BTC', FEE_DEST), { dryRun: { xchainFee: '0.5', sourceFeeBalance: '0' } });
            let r = await ctx.computePreflight({ action: 'ISSUE', params: '0|NEWTICK', source: 'brokePayer' });
            assert.strictEqual(r.feeTokenBalance, '0.00000000');
            assert.strictEqual(r.xchainFee, '0.50000000');
            assert.strictEqual(r.feeAffordable, false);
        });

        it('a funded payer is affordable, and an exact balance counts as covered', async function () {
            let funded = makeCtx(makeUtil('BTC', FEE_DEST), { dryRun: { xchainFee: '0.5', sourceFeeBalance: '19898' } });
            let a = await funded.ctx.computePreflight({ action: 'ISSUE', params: '0|NEWTICK', source: 'rich' });
            assert.strictEqual(a.feeTokenBalance, '19898.00000000');
            assert.strictEqual(a.feeAffordable, true);

            let exact = makeCtx(makeUtil('BTC', FEE_DEST), { dryRun: { xchainFee: '0.5', sourceFeeBalance: '0.5' } });
            let b = await exact.ctx.computePreflight({ action: 'ISSUE', params: '0|NEWTICK', source: 'exact' });
            assert.strictEqual(b.feeAffordable, true, 'balance == fee is enough (>=, not >)');
        });

        it('a fractionally short balance is judged on the ledger value, not the 8dp display', async function () {
            // A ledger balance carries more precision than the displayed string; rounding it
            // up to 8dp before the comparison would resurrect the false PASS.
            let { ctx } = makeCtx(makeUtil('BTC', FEE_DEST), { dryRun: { xchainFee: '0.5', sourceFeeBalance: '0.499999999' } });
            let r = await ctx.computePreflight({ action: 'ISSUE', params: '0|NEWTICK', source: 'almost' });
            assert.strictEqual(r.feeAffordable, false, 'a hair short is short');
            assert.strictEqual(r.feeTokenBalance, '0.50000000', 'display still normalizes to 8dp');
        });

        it('native mode echoes the balance but leaves affordability null (it is not what pays)', async function () {
            let { ctx } = makeCtx(makeUtil('DOGE', FEE_DEST), { dryRun: { xchainFee: '20', sourceFeeBalance: '0' } });
            let r = await ctx.computePreflight({ action: 'ISSUE', params: '0|NEWTICK', source: 'payer' });
            assert.strictEqual(r.feeMode, 'native');
            assert.strictEqual(r.feeTokenBalance, '0.00000000');
            assert.strictEqual(r.feeAffordable, null, 'a native fee is not paid from the XCHAIN balance');
        });

        it('an unavailable balance read is null, never a guessed zero', async function () {
            let { ctx } = makeCtx(makeUtil('BTC', FEE_DEST), { dryRun: { xchainFee: '0.5', sourceFeeBalance: null } });
            let r = await ctx.computePreflight({ action: 'ISSUE', params: '0|NEWTICK' });
            assert.strictEqual(r.feeTokenBalance, null);
            assert.strictEqual(r.feeAffordable, null);
        });

        it('the memo never serves one settlement mode for the other', async function () {
            let { ctx, calls } = makeCtx(makeUtil('BTC', FEE_DEST), { blockIndex: 500 });
            await ctx.computePreflight({ action: 'ISSUE', params: '0|NEWTICK', source: 's', feeMode: 'xchain' });
            await ctx.computePreflight({ action: 'ISSUE', params: '0|NEWTICK', source: 's', feeMode: 'native' });
            assert.strictEqual(calls.dryRuns, 2, 'the two modes are different questions');
            let cached = await ctx.computePreflight({ action: 'ISSUE', params: '0|NEWTICK', source: 's', feeMode: 'native' });
            assert.strictEqual(calls.dryRuns, 2, 'same mode still memoizes');
            assert.strictEqual(cached.cached, true);
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
