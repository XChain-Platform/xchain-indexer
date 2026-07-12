// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const Utility = require('../../src/utility.js');
const Actions = require('../../src/actions.js');

const FEE_DEST    = 'feeDestinationAddr111111111111111';
const PLACEHOLDER = 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

function makeUtil(coin, feeDestination){
    let util = new Utility();
    util.config['COIN']                         = coin;
    util.config['ADDRESS']                      = Object.assign({}, util.config['ADDRESS'] || {}, { FEE_DESTINATION: feeDestination });
    util.config['FEE_TOLERANCE_MIN']            = '0.95';
    util.config['FEE_TOLERANCE_MAX']            = '1.10';
    util.config['ORACLE_MAX_PRICE_AGE_SECONDS'] = 1800;
    util.config['GAS_PRICE']                    = '0.00001';
    return util;
}

function makeDb({ prices = {}, blockIndex = 100, blockTime = 1000 } = {}){
    return {
        getLatestBlockIndex: async () => blockIndex,
        getBlockTime:        async () => blockTime,
        getLatestPrice:      async (pair) => {
            if(prices[pair] == null) return null;
            return { price: prices[pair], roundNumber: 7, block_timestamp: 1000 };
        }
    };
}

// Actions-like context exposing the REAL computeFeeQuote/_priceFeeQuote prototype methods
// with the dry-run engine stubbed (the engine itself is unit-tested in feeQuoteDryRun.test.js).
// dryRun defaults to a valid run whose handler staged a 1.0 XCHAIN fee.
function makeCtx(util, indexerDb, { dryRun } = {}){
    let calls = { dryRunArgs: null, dryRuns: 0 };
    let ctx = {
        config:    util.config,
        util:      util,
        indexerDb: indexerDb,
        _calls:    calls,
        _dryRunAction: async (args) => {
            calls.dryRuns++;
            calls.dryRunArgs = args;
            if(dryRun && dryRun.throws) throw new Error('engine boom');
            return Object.assign({ blockIndex: 100, blockTime: 1000, status: 'valid', error: null, xchainFee: '1.00000000' }, dryRun || {});
        },
        _priceFeeQuote:  Actions.prototype._priceFeeQuote,
        computeFeeQuote: Actions.prototype.computeFeeQuote
    };
    return { ctx, calls };
}

// 1.0 XCHAIN @ $1.00, BTC @ $50,000 => 0.00002 BTC (2000 sats); min 0.000019 (1900), max 0.000022 (2200).
const BTC_PRICES = { 'XCHAIN/USD': '1.00000000', 'BTC/USD': '50000.00000000' };

describe('native coin fee quote @regression @tier1', function () {

    describe('computeNativeFeeBand()', function () {
        it('values 0.5 XCHAIN @ $1.00 against DOGE @ $0.10 => 5.0 (min 4.75, max 5.5)', function () {
            let util = makeUtil('DOGE', FEE_DEST);
            let b = util.computeNativeFeeBand('0.5', '1.00000000', '0.10000000', util.bcnum('0.95'), util.bcnum('1.10'));
            assert.strictEqual(util.bcformat(b.expectedNative, 8), '5.00000000');
            assert.strictEqual(util.bcformat(b.minAcceptable, 8), '4.75000000');
            assert.strictEqual(util.bcformat(b.maxAcceptable, 8), '5.50000000');
        });
    });

    describe('getFeeOraclePrices()', function () {
        it('returns both prices + the COIN/USD round number', async function () {
            let util = makeUtil('BTC', FEE_DEST);
            let r = await util.getFeeOraclePrices(makeDb({ prices: BTC_PRICES }), 'BTC', 100, 1000, 1800);
            assert.ok(!r.error, r.error);
            assert.strictEqual(util.bcformat(r.coinUsdPrice, 8), '50000.00000000');
            assert.strictEqual(util.bcformat(r.xchainUsdPrice, 8), '1.00000000');
            assert.strictEqual(r.oracleRound, 7);
        });

        it('errors when COIN/USD is missing or stale', async function () {
            let util = makeUtil('BTC', FEE_DEST);
            let r = await util.getFeeOraclePrices(makeDb({ prices: { 'XCHAIN/USD': '1.0' } }), 'BTC', 100, 1000, 1800);
            assert.ok(/BTC\/USD .*(missing or stale)/.test(r.error), r.error);
        });
    });

    describe('_priceFeeQuote()', function () {
        it('prices 1.0 XCHAIN at the band midpoint (2000 sats) with band bounds', async function () {
            let util = makeUtil('BTC', FEE_DEST);
            let { ctx } = makeCtx(util, makeDb({ prices: BTC_PRICES }));
            let q = await ctx._priceFeeQuote.call(ctx, { blockIndex: 100 }, '1.00000000', undefined);
            assert.strictEqual(q.valid, true);
            assert.strictEqual(q.xchainFee, '1.00000000');
            assert.strictEqual(q.requiredFeeNative, '0.00002000');
            assert.strictEqual(q.requiredFeeSats, 2000);
            assert.strictEqual(q.minAcceptable, '0.00001900');
            assert.strictEqual(q.maxAcceptable, '0.00002200');
            assert.strictEqual(q.oracleRound, 7);
        });

        it('zero fee: valid with all-zero sizing and no oracle read', async function () {
            let util = makeUtil('BTC', FEE_DEST);
            // No prices seeded: a zero fee must not need them.
            let { ctx } = makeCtx(util, makeDb());
            let q = await ctx._priceFeeQuote.call(ctx, {}, '0', undefined);
            assert.strictEqual(q.valid, true);
            assert.strictEqual(q.requiredFeeSats, 0);
            assert.strictEqual(q.requiredFeeNative, '0.00000000');
        });

        it('judges a proposed output: accepts at exactly min, rejects just below', async function () {
            let util = makeUtil('BTC', FEE_DEST);
            let { ctx } = makeCtx(util, makeDb({ prices: BTC_PRICES }));
            let ok = await ctx._priceFeeQuote.call(ctx, { blockIndex: 100 }, '1.0', 1900);
            assert.strictEqual(ok.valid, true);
            let bad = await ctx._priceFeeQuote.call(ctx, { blockIndex: 100 }, '1.0', 1899);
            assert.strictEqual(bad.valid, false);
            assert.ok(/too small/.test(bad.error), bad.error);
        });

        it('missing/stale price => valid:false with the price error', async function () {
            let util = makeUtil('BTC', FEE_DEST);
            let { ctx } = makeCtx(util, makeDb({ prices: { 'XCHAIN/USD': '1.0' } }));
            let q = await ctx._priceFeeQuote.call(ctx, { blockIndex: 100 }, '1.0', undefined);
            assert.strictEqual(q.valid, false);
            assert.ok(/missing or stale/.test(q.error), q.error);
        });
    });

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

        it('VM/compound actions are deny-listed: supported:false, engine never invoked', async function () {
            let util = makeUtil('BTC', FEE_DEST);
            for(let action of ['DEPLOY', 'EXECUTE', 'XEXEC', 'BATCH', 'deploy']){
                let { ctx, calls } = makeCtx(util, makeDb({ prices: BTC_PRICES }));
                let q = await ctx.computeFeeQuote.call(ctx, { action, params: ['0', 'x'], source: 'src' });
                assert.strictEqual(q.supported, false, action + ' must be unquotable');
                assert.ok(/not supported/.test(q.error), q.error);
                assert.strictEqual(calls.dryRuns, 0, action + ' must not reach the engine');
            }
        });

        it('deny-list cannot be bypassed with whitespace or alias padding: engine never invoked', async function () {
            let util = makeUtil('BTC', FEE_DEST);
            for(let action of [' DEPLOY', 'DEPLOY ', ' deploy ', '\tEXECUTE\n']){
                let { ctx, calls } = makeCtx(util, makeDb({ prices: BTC_PRICES }));
                let q = await ctx.computeFeeQuote.call(ctx, { action, params: ['0', 'x'], source: 'src' });
                assert.strictEqual(q.supported, false, JSON.stringify(action) + ' must be unquotable');
                assert.ok(/not supported/.test(q.error), q.error);
                assert.strictEqual(calls.dryRuns, 0, JSON.stringify(action) + ' must not reach the engine');
            }
        });

        it('fee-exempt settlement/lifecycle actions: zero-fee feeExempt result, engine never invoked', async function () {
            let util = makeUtil('DOGE', FEE_DEST);
            for(let action of ['COINPAY', 'DISPENSE', 'ORDER_MATCH', 'COINPAY_EXPIRE', 'CROSS_SETTLE', 'coinpay']){
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
                let util = makeUtil('BTC', FEE_DEST);
                let { ctx, calls } = makeCtx(util, makeDb({ prices: BTC_PRICES }));
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

        it('invalid (stale/missing price) on a valid action => valid:false with the price error', async function () {
            let util = makeUtil('BTC', FEE_DEST);
            let { ctx } = makeCtx(util, makeDb({ prices: { 'XCHAIN/USD': '1.0' } }));
            let q = await ctx.computeFeeQuote.call(ctx, { action: 'ISSUE', params: ['0', 'NEWTICK'], source: 'src' });
            assert.strictEqual(q.valid, false);
            assert.ok(/missing or stale/.test(q.error), q.error);
        });
    });
});
