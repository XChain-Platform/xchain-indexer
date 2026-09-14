// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// test/unit/fee_quote.test/static_quotes.test.js
//
// The static (no-VM) quotes computeFeeQuote() gives DEPLOY and EXECUTE, sized from
// the gas schedule without ever entering the VM.

const assert = require('assert');

// Utility loads coin config in its constructor from these env vars.
process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const { makeUtil, makeDb, makeCtx, FEE_DEST, PLACEHOLDER, BTC_PRICES } = require('./helpers/quote_ctx.js');

const LTC_PRICES = { 'XCHAIN/USD': '1.00000000', 'LTC/USD': '100.00000000' };
const CODE_B64   = Buffer.from('x', 'utf8').toString('base64');

// DEPLOY/EXECUTE stage their protocol fee from the gas schedule BEFORE entering
// the VM, and that pre-VM number is what validateNativeCoinFee judges the native output
// against. So they get a payable, verdict-free quote instead of the old `supported:false`
// + "pay the fee in XCHAIN", which was unfollowable on LTC/DOGE (no XCHAIN fee lane) and
// left both actions composable but unpayable.
//
// 1 code byte => 100000 + 10 = 100010 gas @ 0.00001 = 1.00010000 XCHAIN;
// @ XCHAIN $1 / LTC $100 => 0.01000100 LTC (1000100 sats), min 0.00950095.

describe('native coin fee quote @regression @tier1', function () {
    describe('computeFeeQuote() [dry-run-backed default]', function () {
        describe('static (no-VM) quotes for DEPLOY/EXECUTE @regression', function () {
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
        });
    });
});

describe('native coin fee quote @regression @tier1', function () {
    describe('computeFeeQuote() [dry-run-backed default]', function () {
        describe('static (no-VM) quotes for DEPLOY/EXECUTE @regression', function () {
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
        });
    });
});

describe('native coin fee quote @regression @tier1', function () {
    describe('computeFeeQuote() [dry-run-backed default]', function () {
        describe('static (no-VM) quotes for DEPLOY/EXECUTE @regression', function () {
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
        });
    });
});

describe('native coin fee quote @regression @tier1', function () {
    describe('computeFeeQuote() [dry-run-backed default]', function () {
        describe('static (no-VM) quotes for DEPLOY/EXECUTE @regression', function () {
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
    });
});
