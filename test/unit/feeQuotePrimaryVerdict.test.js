// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// A fee quote must answer for the action it was ASKED about.
//
// ORDER_MATCH / SWAP_MATCH are dispatched by the ORDER / SWAP handler with the
// ORIGINATING action's OWN record (order.js:560, swap.js:519) and overwrite its
// STATUS and ACTION_INDEX with the match's own (order_match.js:292 and :312).
// On the real path that is invisible - the block loop discards
// processTransaction's return value - but the fee-quote dry run is its ONLY
// consumer, so it used to report the MATCH's verdict as the quoted action's.
//
// MEASURED on Litecoin regtest 2026-07-29, against a real open order:
//   GET /feequote?action=ORDER&params=0|LTC||0.5||LTC|XCHAIN|100&source=<other>
//   -> {"status":"pending_coinpay","valid":false,"error":"pending_coinpay","xchainFee":null}
// The order itself is accepted by the chain; what was "pending" was the match it
// triggers, and that answer is indistinguishable from a real refusal such as
// "invalid: GET_TICK (unknown)". Every wallet that pre-flights therefore refused
// to place the taker side of a CoinPay trade - the whole two-phase settlement
// lane - and got no fee to size, since xchainFee comes back null too.

const assert = require('assert');

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const Utility = require('../../src/utility.js');
const Actions = require('../../src/actions.js');

/** The ORDER's own identity, and the MATCH's, which overwrites it in place. */
const ORDER_INDEX = 41;
const MATCH_INDEX = 77;

/**
 * A dry-run context whose stubbed `processTransaction` reproduces the
 * contamination: it captures the primary verdict exactly as the real
 * `processAction` does when a matcher is dispatched, then hands back a record
 * carrying the MATCH's status and index.
 */
function makeDryRunCtx({ contaminate = true, feeAmount = '1.00000000' } = {}){
    let calls = { feeRecordFor: null };
    let util  = new Utility();
    util.config['COIN'] = 'BTC';
    let ctx = {
        util,
        config: util.config,
        _calls: calls,
        indexerDb: {
            getLatestBlockIndex: async () => 100,
            getBlockTime:        async () => 1000,
            beginTransaction:    async () => {},
            rollbackTransaction: async () => {},
            // Watchdog-fence surface (M-16). _dryRunAction runs under runInDryRunEpoch
            // (the no-consensus-authority variant), so that one is the stub the
            // engine actually calls; runInTxEpoch stays because it is the real Database's
            // default and a future caller that takes it must not lose its stub.
            currentTxEpoch:      () => 0,
            runInTxEpoch:        (epoch, fn) => fn(),
            runInDryRunEpoch:    (epoch, fn) => fn(),
            getFeeRecord:        async (ai) => {
                calls.feeRecordFor = ai;
                // Only the ORDER staged a fee; the match has no fee row, which is
                // why the contaminated read answered null.
                if(ai !== ORDER_INDEX || feeAmount == null) return null;
                return { amount: feeAmount, payment_mode: 1 };
            }
        },
        processTransaction: async () => {
            ctx._primaryVerdict = null;
            if(!contaminate) return { STATUS: 'valid', ACTION_INDEX: ORDER_INDEX };
            // What processAction does the moment ORDER_MATCH is dispatched.
            ctx._primaryVerdict = { status: 'valid', actionIndex: ORDER_INDEX };
            return { STATUS: 'pending_coinpay', ACTION_INDEX: MATCH_INDEX };
        },
        _dryRunAction: Actions.prototype._dryRunAction
    };
    ctx.config['BLOCK_PROCESS_TIMEOUT'] = 300000;
    return { ctx, calls };
}

/**
 * A processAction context with every handler stubbed: enough to prove which
 * dispatches capture a primary verdict and which do not.
 */
function makeDispatchCtx(){
    let util = new Utility();
    let noop = { parse: async () => {} };
    let ctx = {
        util,
        config: util.config,
        _actionCounters: {},
        assignActionAddressIds: async () => {},
        actionOrderMatch: noop,
        actionSwapMatch:  noop,
        actionBroadcast:  noop,
        processAction:    Actions.prototype.processAction
    };
    // resetLists is real Utility behaviour; nothing else here needs stubbing.
    return ctx;
}

describe('a fee quote answers for the action it was asked about', () => {

    it('[REGRESSION] reports the ORDER\'s verdict, not the match it triggered', async () => {
        let { ctx } = makeDryRunCtx();
        let r = await ctx._dryRunAction.call(ctx, {
            action: 'ORDER', params: ['0', 'LTC', '', '0.5', '', 'LTC', 'XCHAIN', '100'],
            source: 'taker', timeoutMs: 300000,
        });
        assert.strictEqual(r.status, 'valid',
            'an ORDER that fills on arrival is quoted as its match\'s pending state, so the '
            + 'wallet refuses an action the chain accepts');
    });

    it('[REGRESSION] reads the fee row of the ORDER, not of the match', async () => {
        let { ctx, calls } = makeDryRunCtx();
        let r = await ctx._dryRunAction.call(ctx, {
            action: 'ORDER', params: ['0'], source: 'taker', timeoutMs: 300000,
        });
        assert.strictEqual(calls.feeRecordFor, ORDER_INDEX,
            'the fee was looked up under the match\'s action index, which has no fee row');
        assert.strictEqual(r.xchainFee, '1.00000000',
            'the quoted action\'s own staged fee is what the caller has to pay');
    });

    it('an uncontaminated run is unchanged: the record\'s own status and index are used', async () => {
        let { ctx, calls } = makeDryRunCtx({ contaminate: false });
        let r = await ctx._dryRunAction.call(ctx, {
            action: 'ISSUE', params: ['0', 'TOK', '1000'], source: 'src', timeoutMs: 300000,
        });
        assert.strictEqual(r.status, 'valid');
        assert.strictEqual(calls.feeRecordFor, ORDER_INDEX);
        assert.strictEqual(r.xchainFee, '1.00000000');
    });

    it('a rejection still surfaces: the primary verdict carries a refusal through unchanged', async () => {
        let { ctx } = makeDryRunCtx();
        ctx.processTransaction = async () => {
            ctx._primaryVerdict = { status: 'invalid: insufficient funds (GIVE_AMOUNT)', actionIndex: ORDER_INDEX };
            return { STATUS: 'pending_coinpay', ACTION_INDEX: MATCH_INDEX };
        };
        // A refused handler stages no fee row, which is what makes xchainFee null.
        ctx.indexerDb.getFeeRecord = async () => null;
        let r = await ctx._dryRunAction.call(ctx, {
            action: 'ORDER', params: ['0'], source: 'taker', timeoutMs: 300000,
        });
        assert.strictEqual(r.status, 'invalid: insufficient funds (GIVE_AMOUNT)',
            'preferring the primary verdict must not swallow a genuine refusal');
        assert.strictEqual(r.xchainFee, null, 'a refused action stages no fee');
    });

    describe('which dispatches capture a primary verdict', () => {

        it('ORDER_MATCH captures the record it was handed, before overwriting it', async () => {
            let ctx  = makeDispatchCtx();
            let data = { STATUS: 'valid', ACTION_INDEX: ORDER_INDEX };
            ctx._primaryVerdict = null;
            await ctx.processAction.call(ctx, 'ORDER_MATCH', null, data, null);
            assert.deepStrictEqual(ctx._primaryVerdict, { status: 'valid', actionIndex: ORDER_INDEX });
        });

        it('SWAP_MATCH does too (swap.js hands over its record the same way)', async () => {
            let ctx  = makeDispatchCtx();
            let data = { STATUS: 'valid', ACTION_INDEX: ORDER_INDEX };
            ctx._primaryVerdict = null;
            await ctx.processAction.call(ctx, 'SWAP_MATCH', null, data, null);
            assert.deepStrictEqual(ctx._primaryVerdict, { status: 'valid', actionIndex: ORDER_INDEX });
        });

        it('an ordinary action captures nothing, so nothing else changes shape', async () => {
            let ctx  = makeDispatchCtx();
            let data = { STATUS: 'valid', ACTION_INDEX: 5 };
            ctx._primaryVerdict = null;
            await ctx.processAction.call(ctx, 'BROADCAST', null, data, null);
            assert.strictEqual(ctx._primaryVerdict, null);
        });

        it('only the FIRST matcher wins, so a second fill cannot overwrite the verdict', async () => {
            let ctx  = makeDispatchCtx();
            ctx._primaryVerdict = null;
            await ctx.processAction.call(ctx, 'ORDER_MATCH', null,
                { STATUS: 'valid', ACTION_INDEX: ORDER_INDEX }, null);
            await ctx.processAction.call(ctx, 'ORDER_MATCH', null,
                { STATUS: 'pending_coinpay', ACTION_INDEX: MATCH_INDEX }, null);
            assert.deepStrictEqual(ctx._primaryVerdict, { status: 'valid', actionIndex: ORDER_INDEX });
        });
    });
});
