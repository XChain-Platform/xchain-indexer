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
    // Only the keys the static (no-VM) fee quote prices from; same values as coins/LTC.js.
    util.config['GAS_SCHEDULE']                 = Object.assign({}, util.config['GAS_SCHEDULE'] || {}, {
        VM_EXECUTE_BASE:    1000,
        VM_DEPLOY_BASE:     100000,
        VM_DEPLOY_PER_BYTE: 10
    });
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
function makeCtx(util, indexerDb, { dryRun, base64CodeEra = true } = {}){
    let calls = { dryRunArgs: null, dryRuns: 0 };
    let ctx = {
        config:    util.config,
        util:      util,
        indexerDb: indexerDb,
        _calls:    calls,
        // DEPLOY_BASE64_CODE is the only flag-day the quote path reads (inline code decode).
        protocolChanges: { isEnabled: async (name) => (name === 'DEPLOY_BASE64_CODE' ? base64CodeEra : true) },
        _nativeFeeMandatory:     Actions.prototype._nativeFeeMandatory,
        _decodeDeployCodeBytes:  Actions.prototype._decodeDeployCodeBytes,
        _staticProtocolFee:      Actions.prototype._staticProtocolFee,
        _staticFeeQuote:         Actions.prototype._staticFeeQuote,
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

    // #2693: the flag-day gate (NATIVE_FEE_PRICE_TIME_GATE) must anchor on a chain-derived time
    // (gateTime), not the operator wall-clock, while staleness stays on refTime. The 6th arg
    // threads gateTime; default gateTime = refTime keeps the consensus caller byte-identical.
    describe('getFeeOraclePrices() gate-time threading', function () {
        const GATE = require('../../src/protocol_changes.js').NATIVE_FEE_PRICE_TIME_GATE_MAINNET_TIME;
        // DB stub that records the opts (selectByTime, blockTime) getLatestPrice was called with.
        function makeCapturingDb(){
            let seen = { opts: null };
            let db = {
                getLatestBlockIndex: async () => 100,
                getLatestPrice: async (pair, blockIndex, opts) => {
                    seen.opts = opts;
                    let p = { 'XCHAIN/USD': '1.00000000', 'DOGE/USD': '0.10000000' }[pair];
                    return p == null ? null : { price: p, roundNumber: 7, block_timestamp: 1000 };
                }
            };
            return { db, seen };
        }
        function mainnetUtil(){
            let util = makeUtil('DOGE', FEE_DEST);
            util.config['NETWORK'] = 'mainnet';
            return util;
        }

        it('quote path: block time before the gate + wall-clock after keeps the gate INACTIVE', async function () {
            let util = mainnetUtil();
            let { db, seen } = makeCapturingDb();
            // refTime = wall-clock after the flag-day; gateTime = quoted block before it.
            let r = await util.getFeeOraclePrices(db, 'DOGE', 100, GATE + 1000, 1800, GATE - 1000);
            assert.ok(!r.error, r.error);
            assert.strictEqual(seen.opts.selectByTime, false, 'gate must follow chain time (before), not wall-clock');
            assert.strictEqual(seen.opts.blockTime, GATE + 1000, 'staleness stays anchored on refTime');
        });

        it('default gateTime = refTime (consensus caller) is unchanged: refTime after gate => ACTIVE', async function () {
            let util = mainnetUtil();
            let { db, seen } = makeCapturingDb();
            // No 6th arg: gateTime defaults to refTime (validateNativeCoinFee passes BLOCK_TIME).
            await util.getFeeOraclePrices(db, 'DOGE', 100, GATE + 1000, 1800);
            assert.strictEqual(seen.opts.selectByTime, true, 'default gateTime=refTime, gate active past flag-day');
        });

        it('default gateTime = refTime: refTime before gate => INACTIVE', async function () {
            let util = mainnetUtil();
            let { db, seen } = makeCapturingDb();
            await util.getFeeOraclePrices(db, 'DOGE', 100, GATE - 1000, 1800);
            assert.strictEqual(seen.opts.selectByTime, false);
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

        // : DEPLOY/EXECUTE stage their protocol fee from the gas schedule BEFORE entering
        // the VM, and that pre-VM number is what validateNativeCoinFee judges the native output
        // against. So they get a payable, verdict-free quote instead of the old `supported:false`
        // + "pay the fee in XCHAIN", which was unfollowable on LTC/DOGE (no XCHAIN fee lane) and
        // left both actions composable but unpayable.
        //
        // 1 code byte => 100000 + 10 = 100010 gas @ 0.00001 = 1.00010000 XCHAIN;
        // @ XCHAIN $1 / LTC $100 => 0.01000100 LTC (1000100 sats), min 0.00950095.
        describe('static (no-VM) quotes for DEPLOY/EXECUTE @regression', function () {
            const LTC_PRICES = { 'XCHAIN/USD': '1.00000000', 'LTC/USD': '100.00000000' };
            const CODE_B64   = Buffer.from('x', 'utf8').toString('base64');

            it('DEPLOY v0 inline: payable fee, no verdict, engine never invoked', async function () {
                let util = makeUtil('LTC', FEE_DEST);
                let { ctx, calls } = makeCtx(util, makeDb({ prices: LTC_PRICES }));
                let q = await ctx.computeFeeQuote.call(ctx, { action: 'DEPLOY', params: ['0', CODE_B64, '500000', ''], source: 'src' });
                assert.strictEqual(calls.dryRuns, 0, 'the VM engine must never run on the public path');
                assert.strictEqual(q.supported, true);
                assert.strictEqual(q.staticQuote, true);
                assert.strictEqual(q.validated, false);
                assert.strictEqual(q.valid, null, 'a sized fee is not a validity verdict');
                assert.strictEqual(q.gasCost, 100010);
                assert.strictEqual(q.xchainFee, '1.00010000');
                assert.strictEqual(q.requiredFeeNative, '0.01000100');
                assert.strictEqual(q.requiredFeeSats, 1000100);
                assert.strictEqual(q.feeDestination, FEE_DEST);
                assert.ok(/NOT pre-judged/.test(q.note), q.note);
            });

            it('EXECUTE: VM_EXECUTE_BASE only (metered gas re-prices the record, not the check)', async function () {
                let util = makeUtil('LTC', FEE_DEST);
                let { ctx, calls } = makeCtx(util, makeDb({ prices: LTC_PRICES }));
                let q = await ctx.computeFeeQuote.call(ctx, { action: 'EXECUTE', params: ['0', 'contract1', 'method', 'arg'], source: 'src' });
                assert.strictEqual(calls.dryRuns, 0);
                assert.strictEqual(q.supported, true);
                assert.strictEqual(q.valid, null);
                assert.strictEqual(q.gasCost, 1000);
                assert.strictEqual(q.xchainFee, '0.01000000');
                assert.strictEqual(q.requiredFeeSats, 10000);
            });

            it('DEPLOY v2/v3 chunked: base only, the v4 carriers already paid per-byte', async function () {
                let util = makeUtil('LTC', FEE_DEST);
                for(let version of ['2', '3']){
                    let { ctx } = makeCtx(util, makeDb({ prices: LTC_PRICES }));
                    let q = await ctx.computeFeeQuote.call(ctx, { action: 'DEPLOY', params: [version, 'a'.repeat(64), '500000', ''], source: 'src' });
                    assert.strictEqual(q.gasCost, 100000, 'v' + version + ' charges no per-byte component');
                    assert.strictEqual(q.xchainFee, '1.00000000');
                }
            });

            it('DEPLOY v4 carrier: per-byte on the base64 slice as carried', async function () {
                let util = makeUtil('LTC', FEE_DEST);
                let { ctx } = makeCtx(util, makeDb({ prices: LTC_PRICES }));
                let q = await ctx.computeFeeQuote.call(ctx, { action: 'DEPLOY', params: ['4', 'a'.repeat(64), '0', '2', 'QUJD'], source: 'src' });
                assert.strictEqual(q.gasCost, 40, '4 carried base64 chars * VM_DEPLOY_PER_BYTE');
                assert.strictEqual(q.xchainFee, '0.00040000');
            });

            it('pre-activation hex era decodes as hex (byte count must match the handler)', async function () {
                let util = makeUtil('LTC', FEE_DEST);
                let { ctx } = makeCtx(util, makeDb({ prices: LTC_PRICES }), { base64CodeEra: false });
                let q = await ctx.computeFeeQuote.call(ctx, { action: 'DEPLOY', params: ['0', '78', '500000', ''], source: 'src' });
                assert.strictEqual(q.gasCost, 100010, "hex '78' is the same 1 byte of source");
            });

            it('non-canonical CODE_ENCODING rejects with the handler string, no fee sizing', async function () {
                let util = makeUtil('LTC', FEE_DEST);
                let { ctx } = makeCtx(util, makeDb({ prices: LTC_PRICES }));
                let q = await ctx.computeFeeQuote.call(ctx, { action: 'DEPLOY', params: ['0', 'not!base64', '500000', ''], source: 'src' });
                assert.strictEqual(q.valid, false, 'a doomed input must not be quoted a payable fee');
                assert.strictEqual(q.error, 'invalid: CODE_ENCODING (base64 decode failed)');
                assert.strictEqual(q.requiredFeeSats, undefined);
            });

            it('missing CODE_ENCODING and unknown VERSION reject before pricing', async function () {
                let util = makeUtil('LTC', FEE_DEST);
                let cases = [
                    { params: ['0', '', '500000', ''],   error: 'invalid: CODE_ENCODING (required)' },
                    { params: ['9', CODE_B64, '500000'], error: 'invalid: VERSION (unknown)' }
                ];
                for(let c of cases){
                    let { ctx } = makeCtx(util, makeDb({ prices: LTC_PRICES }));
                    let q = await ctx.computeFeeQuote.call(ctx, { action: 'DEPLOY', params: c.params, source: 'src' });
                    assert.strictEqual(q.valid, false);
                    assert.strictEqual(q.error, c.error);
                }
            });

            it('a caller-supplied output below the band is still a hard reject', async function () {
                let util = makeUtil('LTC', FEE_DEST);
                let { ctx } = makeCtx(util, makeDb({ prices: LTC_PRICES }));
                let q = await ctx.computeFeeQuote.call(ctx,
                    { action: 'DEPLOY', params: ['0', CODE_B64, '500000', ''], source: 'src', feeOutputSats: 900000 });
                assert.strictEqual(q.valid, false, 'an under-min output is computed, not assumed');
                assert.ok(/too small/.test(q.error), q.error);
                // At the band minimum it is payable again (and still verdict-free).
                let ok = makeCtx(util, makeDb({ prices: LTC_PRICES }));
                let q2 = await ok.ctx.computeFeeQuote.call(ok.ctx,
                    { action: 'DEPLOY', params: ['0', CODE_B64, '500000', ''], source: 'src', feeOutputSats: 950095 });
                assert.strictEqual(q2.valid, null);
            });

            it('an unpriceable oracle keeps the quote invalid (never a payable-looking answer)', async function () {
                let util = makeUtil('LTC', FEE_DEST);
                let { ctx } = makeCtx(util, makeDb({ prices: { 'XCHAIN/USD': '1.00000000' } }));
                let q = await ctx.computeFeeQuote.call(ctx, { action: 'DEPLOY', params: ['0', CODE_B64, '500000', ''], source: 'src' });
                assert.strictEqual(q.valid, false);
                assert.ok(/LTC\/USD/.test(q.error), q.error);
                assert.strictEqual(q.requiredFeeSats, undefined);
            });

            it('BATCH/XEXEC refusal on a native-only chain does not advise the XCHAIN lane', async function () {
                let util = makeUtil('DOGE', FEE_DEST);
                let { ctx } = makeCtx(util, makeDb({ prices: BTC_PRICES }));
                let q = await ctx.computeFeeQuote.call(ctx, { action: 'BATCH', params: ['0', 'SEND|0|FOO|1|dest'], source: 'src' });
                assert.strictEqual(q.supported, false);
                assert.ok(!/pay the fee in XCHAIN/.test(q.error), 'DOGE has no XCHAIN fee lane: ' + q.error);
                assert.ok(/DOGE/.test(q.error), q.error);
                // BTC keeps the historical advice, which is followable there.
                let btc = makeCtx(makeUtil('BTC', FEE_DEST), makeDb({ prices: BTC_PRICES }));
                let qb = await btc.ctx.computeFeeQuote.call(btc.ctx, { action: 'BATCH', params: ['0', 'x'], source: 'src' });
                assert.ok(/pay the fee in XCHAIN/.test(qb.error), qb.error);
            });

            it('a schedule that cannot price the action fails closed to the refusal', async function () {
                let util = makeUtil('LTC', FEE_DEST);
                delete util.config['GAS_SCHEDULE'].VM_EXECUTE_BASE;
                let { ctx } = makeCtx(util, makeDb({ prices: LTC_PRICES }));
                let q = await ctx.computeFeeQuote.call(ctx, { action: 'EXECUTE', params: ['0', 'c1', 'm'], source: 'src' });
                assert.strictEqual(q.supported, false, 'a missing schedule key must not quote 0 or NaN');
                assert.strictEqual(q.requiredFeeSats, undefined);
            });

            it('an over-long CODE_ENCODING is rejected without being decoded', async function () {
                let util = makeUtil('LTC', FEE_DEST);
                let { ctx } = makeCtx(util, makeDb({ prices: LTC_PRICES }));
                let q = await ctx.computeFeeQuote.call(ctx,
                    { action: 'DEPLOY', params: ['0', 'A'.repeat(200000), '500000', ''], source: 'src' });
                assert.strictEqual(q.valid, false);
                assert.strictEqual(q.error, 'invalid: CODE_ENCODING (exceeds max size)');
            });

            it('no FEE_DESTINATION still short-circuits before any static pricing', async function () {
                let util = makeUtil('LTC', PLACEHOLDER);
                let { ctx } = makeCtx(util, makeDb({ prices: LTC_PRICES }));
                let q = await ctx.computeFeeQuote.call(ctx, { action: 'DEPLOY', params: ['0', CODE_B64, '500000', ''], source: 'src' });
                assert.strictEqual(q.supported, false);
                assert.ok(/not enabled/.test(q.error), q.error);
            });
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
