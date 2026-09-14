// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// test/unit/fee_quote.test/compute_fee_quote.test.js
//
// computeFeeQuote() on its dry-run-backed default path: the handler verdict, the
// deny-list, fee-exempt actions, the admission cap and its env overrides.

const assert = require('assert');

// Utility loads coin config in its constructor from these env vars.
process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const { requireWithFreshConfig } = require('../../helpers/fresh_config.js');
const ACTIONS_PATH = require.resolve('../../../src/actions/index.js');
const { makeUtil, makeDb, makeCtx, FEE_DEST, PLACEHOLDER, BTC_PRICES } = require('./helpers/quote_ctx.js');

describe('native coin fee quote @regression @tier1', function () {
    describe('computeFeeQuote() [dry-run-backed default]', function () {
        it('valid handler run: prices the handler-staged fee, carries status + validated', async function () {
            let util = makeUtil('BTC', FEE_DEST);
            let { ctx, calls } = makeCtx(util, makeDb({ prices: BTC_PRICES }));
            let q = await ctx.computeFeeQuote.call(ctx, { action: 'ISSUE', params: ['0', 'NEWTICK'], source: 'src' });
            assert.strictEqual(q.supported, true);
            assert.strictEqual(q.valid, true);
            assert.strictEqual(q.validated, true);
            assert.strictEqual(q.status, 'valid');
            assert.strictEqual(q.xchainFee, '1.00000000');
            assert.strictEqual(q.requiredFeeSats, 2000);
            assert.strictEqual(q.feeDestination, FEE_DEST);
            assert.strictEqual(calls.dryRuns, 1);
        });

        it('passes the probe destination + default timeout to the engine', async function () {
            let util = makeUtil('BTC', FEE_DEST);
            let { ctx, calls } = makeCtx(util, makeDb({ prices: BTC_PRICES }));
            await ctx.computeFeeQuote.call(ctx, { action: 'SEND', params: '0|FOO|1|dest', source: 'src' });
            assert.strictEqual(calls.dryRunArgs.probeFeeDestination, FEE_DEST);
            assert.strictEqual(calls.dryRunArgs.timeoutMs, 10000);
            assert.deepStrictEqual(calls.dryRunArgs.params, ['0', 'FOO', '1', 'dest'], 'pipe-string params split');
        });

        it('previously-unsupported actions (SEND) now quote through the handler', async function () {
            let util = makeUtil('BTC', FEE_DEST);
            let { ctx } = makeCtx(util, makeDb({ prices: BTC_PRICES }), { dryRun: { xchainFee: '0.00100000' } });
            let q = await ctx.computeFeeQuote.call(ctx, { action: 'SEND', params: ['0', 'FOO', '1', 'dest'], source: 'src' });
            assert.strictEqual(q.supported, true);
            assert.strictEqual(q.valid, true);
            assert.strictEqual(q.xchainFee, '0.00100000');
        });

        it('class-B invalid: handler verdict + reason surface verbatim, no pricing', async function () {
            let util = makeUtil('BTC', FEE_DEST);
            let { ctx } = makeCtx(util, makeDb({ prices: BTC_PRICES }),
                { dryRun: { status: 'invalid: insufficient funds', xchainFee: null } });
            let q = await ctx.computeFeeQuote.call(ctx, { action: 'SEND', params: ['0', 'FOO', '999', 'dest'], source: 'src' });
            assert.strictEqual(q.supported, true);
            assert.strictEqual(q.valid, false);
            assert.strictEqual(q.status, 'invalid: insufficient funds');
            assert.strictEqual(q.error, 'invalid: insufficient funds');
            assert.strictEqual(q.xchainFee, null);
            assert.strictEqual(q.requiredFeeSats, undefined, 'no sizing for an invalid action');
        });
    });
});

describe('native coin fee quote @regression @tier1', function () {
    describe('computeFeeQuote() [dry-run-backed default]', function () {
        it('XEXEC/BATCH stay unquotable: supported:false, engine never invoked', async function () {
            let util = makeUtil('BTC', FEE_DEST);
            for(let action of ['XEXEC', 'BATCH']){
                let { ctx, calls } = makeCtx(util, makeDb({ prices: BTC_PRICES }));
                let q = await ctx.computeFeeQuote.call(ctx, { action, params: ['0', 'x'], source: 'src' });
                assert.strictEqual(q.supported, false, action + ' must be unquotable');
                assert.strictEqual(q.denied, true);
                assert.ok(/not supported/.test(q.error), q.error);
                assert.strictEqual(calls.dryRuns, 0, action + ' must not reach the engine');
            }
        });

        it('deny-list cannot be bypassed with whitespace or alias padding: engine never invoked', async function () {
            let util = makeUtil('BTC', FEE_DEST);
            for(let action of [' DEPLOY', 'DEPLOY ', ' deploy ', '\tEXECUTE\n', ' batch ']){
                let { ctx, calls } = makeCtx(util, makeDb({ prices: BTC_PRICES }));
                let q = await ctx.computeFeeQuote.call(ctx, { action, params: ['0', 'x'], source: 'src' });
                assert.strictEqual(calls.dryRuns, 0, JSON.stringify(action) + ' must not reach the engine');
                assert.notStrictEqual(q.valid, true, JSON.stringify(action) + ' must never claim a verdict');
            }
        });

        it('fee-exempt settlement/lifecycle actions: zero-fee feeExempt result, engine never invoked', async function () {
            let util = makeUtil('DOGE', FEE_DEST);
            for(let action of ['COINPAY', 'DISPENSE', 'ORDER_MATCH', 'COINPAY_EXPIRE', 'CROSS_SETTLE', 'XCALL', 'coinpay']){
                let { ctx, calls } = makeCtx(util, makeDb({ prices: BTC_PRICES }));
                let q = await ctx.computeFeeQuote.call(ctx, { action, params: ['0', '5'], source: 'src' });
                assert.strictEqual(q.supported, true, action + ' is answerable');
                assert.strictEqual(q.valid, true, action + ' needs no fee output');
                assert.strictEqual(q.feeExempt, true, action + ' must be flagged fee-exempt');
                assert.strictEqual(q.xchainFee, '0.00000000');
                assert.strictEqual(q.requiredFeeSats, 0);
                assert.strictEqual(calls.dryRuns, 0, action + ' must not reach the engine');
            }
        });

        it('no FEE_DESTINATION configured => supported:false, engine never invoked', async function () {
            let util = makeUtil('BTC', PLACEHOLDER);
            let { ctx, calls } = makeCtx(util, makeDb({ prices: BTC_PRICES }));
            let q = await ctx.computeFeeQuote.call(ctx, { action: 'ISSUE', params: ['0', 'NEWTICK'], source: 'src' });
            assert.strictEqual(q.supported, false);
            assert.ok(/not enabled/.test(q.error), q.error);
            assert.strictEqual(calls.dryRuns, 0);
        });
    });
});

describe('native coin fee quote @regression @tier1', function () {
    describe('computeFeeQuote() [dry-run-backed default]', function () {
        it('admission cap: over-cap quotes get a retryable busy error, engine never invoked', async function () {
            let util = makeUtil('BTC', FEE_DEST);
            let { ctx, calls } = makeCtx(util, makeDb({ prices: BTC_PRICES }));
            ctx._feeQuotePending = 8;   // default INDEXER_FEEQUOTE_MAX_PENDING
            let q = await ctx.computeFeeQuote.call(ctx, { action: 'ISSUE', params: ['0', 'NEWTICK'], source: 'src' });
            assert.strictEqual(q.valid, false);
            assert.strictEqual(q.busy, true);
            assert.strictEqual(q.retryable, true);
            assert.strictEqual(calls.dryRuns, 0);
            assert.strictEqual(ctx._feeQuotePending, 8, 'rejected quote must not touch the counter');
        });

        it('pending counter is released after the run, including on engine throw', async function () {
            let util = makeUtil('BTC', FEE_DEST);
            let { ctx } = makeCtx(util, makeDb({ prices: BTC_PRICES }), { dryRun: { throws: true } });
            await assert.rejects(() => ctx.computeFeeQuote.call(ctx, { action: 'ISSUE', params: ['0', 'X'], source: 'src' }));
            assert.strictEqual(ctx._feeQuotePending, 0, 'counter released in finally');
            // And a healthy run leaves it at zero too.
            let ok = makeCtx(util, makeDb({ prices: BTC_PRICES }));
            await ok.ctx.computeFeeQuote.call(ok.ctx, { action: 'ISSUE', params: ['0', 'X'], source: 'src' });
            assert.strictEqual(ok.ctx._feeQuotePending, 0);
        });

        it('honors INDEXER_FEEQUOTE_MAX_PENDING / INDEXER_FEEQUOTE_TIMEOUT_MS overrides', async function () {
            process.env.INDEXER_FEEQUOTE_MAX_PENDING = '2';
            process.env.INDEXER_FEEQUOTE_TIMEOUT_MS  = '2500';
            try {
                // Both overrides are read from src/config.js's load-time CONFIG_ENV snapshot,
                // so the quote methods come from an Actions loaded after the env write.
                const FreshActions = requireWithFreshConfig(ACTIONS_PATH);
                let util = makeUtil('BTC', FEE_DEST);
                let { ctx, calls } = makeCtx(util, makeDb({ prices: BTC_PRICES }), { actions: FreshActions });
                ctx._feeQuotePending = 2;
                let q = await ctx.computeFeeQuote.call(ctx, { action: 'ISSUE', params: ['0', 'X'], source: 'src' });
                assert.strictEqual(q.busy, true, 'cap override respected');
                ctx._feeQuotePending = 0;
                await ctx.computeFeeQuote.call(ctx, { action: 'ISSUE', params: ['0', 'X'], source: 'src' });
                assert.strictEqual(calls.dryRunArgs.timeoutMs, 2500, 'timeout override respected');
            } finally {
                delete process.env.INDEXER_FEEQUOTE_MAX_PENDING;
                delete process.env.INDEXER_FEEQUOTE_TIMEOUT_MS;
            }
        });
    });
});

describe('native coin fee quote @regression @tier1', function () {
    describe('computeFeeQuote() [dry-run-backed default]', function () {
        it('invalid (stale/missing price) on a valid action => valid:false with the price error', async function () {
            let util = makeUtil('BTC', FEE_DEST);
            let { ctx } = makeCtx(util, makeDb({ prices: { 'XCHAIN/USD': '1.0' } }));
            let q = await ctx.computeFeeQuote.call(ctx, { action: 'ISSUE', params: ['0', 'NEWTICK'], source: 'src' });
            assert.strictEqual(q.valid, false);
            assert.ok(/missing or stale/.test(q.error), q.error);
        });
    });
});
