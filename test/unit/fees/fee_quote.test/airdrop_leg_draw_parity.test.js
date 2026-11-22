// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// test/unit/fees/fee_quote.test/airdrop_leg_draw_parity.test.js
//
// A multi-leg AIRDROP past its tally gate pays every leg from one fee output, each leg judging
// what the earlier legs left against its own band. The quote must reach the verdict the real
// validateNativeCoinFee reaches over an action NATIVE_FEE_LEDGER, never the looser verdict of a
// single band over the summed fee.

const assert = require('assert');
const { FEE_DEST, makeUtil, makeDb, makeCtx, BTC_PRICES } = require('./helpers/quote_ctx.js');
const { readDryRunVerdict, dryRunOutcome } = require('../../../../src/actions/actions_class/dry_run_support.js');

// At BTC_PRICES 500 XCHAIN prices to 0.01 BTC, so two such legs expect 0.02 in all.
const TWO_EQUAL = ['500.00000000', '500.00000000'];

function sumOf(util, legs){
    return legs.reduce((sum, fee) => util.bcformat(util.bcadd(sum, fee, 8), 8), '0');
}

async function quote(legs, sats){
    let util = makeUtil('BTC', FEE_DEST);
    let { ctx } = makeCtx(util, makeDb({ prices: BTC_PRICES }));
    return ctx.priceFeeQuote.call(ctx, { blockIndex: 100, blockTime: 1000 }, sumOf(util, legs), sats, legs);
}

// The chain's verdict: every leg through the real validateNativeCoinFee, in order, over one tally.
async function chainAccepts(legs, sats){
    let util = makeUtil('BTC', FEE_DEST);
    let db = makeDb({ prices: BTC_PRICES });
    let ledger = { nativeFeeConsumed: '0', xchainFee: '0', gasCost: '0' };
    let outputs = [{ address: FEE_DEST, value: util.bcformat(util.bcdiv(sats, 100000000, 8), 8) }];
    let data = { BLOCK_INDEX: 100, BLOCK_TIME: 1000 };
    let all = true;
    for(let fee of legs){
        let fees = { AMOUNT: fee, NATIVE_FEE_AMOUNT: fee, NATIVE_FEE_LEDGER: ledger };
        let verdict = await util.validateNativeCoinFee(data, fees, db, outputs);
        if(!verdict.valid) all = false;
    }
    return all;
}

// Sweeps outputs around every boundary of one leg shape, comparing the quote with the chain at
// each step and one sat below it, then proves the quoted minimum is the chain's exact floor.
async function assertShapeParity(legs){
    for(let sats = 1500000; sats <= 4100000; sats += 12500){
        for(let probe of [sats, sats - 1]){
            let q = await quote(legs, probe);
            assert.strictEqual(q.valid, await chainAccepts(legs, probe), legs.join('|') + ' @ ' + probe);
        }
    }
    let floor = Number((await quote(legs, undefined)).minAcceptable.replace('.', ''));
    assert.strictEqual(await chainAccepts(legs, floor), true, legs.join('|') + ' at its minimum');
    assert.strictEqual(await chainAccepts(legs, floor - 1), false, legs.join('|') + ' below its minimum');
}

// Drives computeFeeQuote with a stubbed dry run that discloses two equal legs.
async function assertComputeFeeQuoteUsesDisclosure(){
    let util = makeUtil('BTC', FEE_DEST);
    let dryRun = { xchainFee: '1000.00000000', nativeFeeLegs: TWO_EQUAL };
    let { ctx } = makeCtx(util, makeDb({ prices: BTC_PRICES }), { dryRun });
    let request = { action: 'AIRDROP', params: ['2', 'TEST', '10', '1', 'TEST', '10', '1'], source: 'src' };
    let q = await ctx.computeFeeQuote.call(ctx, Object.assign({ feeOutputSats: 1900000 }, request));
    assert.strictEqual(q.validated, true);
    assert.strictEqual(q.valid, false, JSON.stringify(q));
    assert.strictEqual(q.minAcceptable, '0.01950000');
    let ok = await ctx.computeFeeQuote.call(ctx, Object.assign({ feeOutputSats: 1950000 }, request));
    assert.strictEqual(ok.valid, true, JSON.stringify(ok));
}

describe('multi-leg AIRDROP fee quote replays the in-order leg draw @regression @tier1', function () {
    it('refuses 0.019 for two 0.01 legs and reports the in-order minimum 0.0195', async function () {
        let q = await quote(TWO_EQUAL, 1900000);
        assert.strictEqual(q.valid, false);
        assert.strictEqual(q.minAcceptable, '0.01950000');
        assert.match(q.error, /AIRDROP leg 2 of 2 refused/);
        assert.strictEqual(await chainAccepts(TWO_EQUAL, 1900000), false);
        assert.strictEqual((await quote(TWO_EQUAL, 1950000)).valid, true);
        assert.strictEqual((await quote(TWO_EQUAL, 1949999)).valid, false);
    });

    it('keeps the summed expected fee as the recommendation, and the chain accepts it', async function () {
        let q = await quote(TWO_EQUAL, undefined);
        assert.strictEqual(q.valid, true);
        assert.strictEqual(q.expectedNative, '0.02000000');
        assert.strictEqual(q.requiredFeeSats, 2000000);
        assert.strictEqual(await chainAccepts(TWO_EQUAL, q.requiredFeeSats), true);
    });

    it('agrees with the chain across outputs for equal, unequal and zero-fee middle legs', async function () {
        this.timeout(30000);
        let shapes = [TWO_EQUAL, ['500', '1500'], ['1500', '500'], ['500', '0', '500'], ['250', '250', '250']];
        for(let legs of shapes) await assertShapeParity(legs);
    });

    it('leaves a single charged leg and an undisclosed run on the summed band', async function () {
        let single = await quote(['1000', '0'], 1900000);
        assert.strictEqual(single.valid, true);
        assert.strictEqual(single.minAcceptable, '0.01900000');
        let util = makeUtil('BTC', FEE_DEST);
        let { ctx } = makeCtx(util, makeDb({ prices: BTC_PRICES }));
        let plain = await ctx.priceFeeQuote.call(ctx, { blockIndex: 100 }, '1000', 1900000);
        assert.strictEqual(plain.valid, true);
        assert.strictEqual(plain.error, null);
        assert.strictEqual(plain.minAcceptable, '0.01900000');
    });

    it('judges a computeFeeQuote AIRDROP output by the run\'s per-leg disclosure', async function () {
        await assertComputeFeeQuoteUsesDisclosure();
    });

    it('hands the probe\'s per-leg disclosure from the run to the quote', async function () {
        let actions = { _primaryVerdict: null, util: makeUtil('BTC', FEE_DEST), indexerDb: {} };
        let verdict = { status: null, feeRecord: null };
        await readDryRunVerdict(actions, { STATUS: 'valid', PROBE_NATIVE_FEE_LEGS: TWO_EQUAL }, verdict);
        assert.deepStrictEqual(dryRunOutcome(100, 1000, verdict, null, null).nativeFeeLegs, TWO_EQUAL);
        let bare = { status: null, feeRecord: null };
        await readDryRunVerdict(actions, { STATUS: 'valid' }, bare);
        assert.strictEqual(dryRunOutcome(100, 1000, bare, null, null).nativeFeeLegs, null);
    });
});
