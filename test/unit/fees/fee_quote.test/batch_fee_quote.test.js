// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict';

const assert = require('assert');
const Actions = require('../../../../src/actions/index.js');
const { makeUtil, makeDb, makeCtx, FEE_DEST } = require('./helpers/quote_ctx.js');

const EXECUTE_GATE = 'XC_EXECUTE_NATIVE_METERED_GAS_REGTEST_ACTIVATION';
const DOGE_PRICES = { 'XCHAIN/USD': '1.00000000', 'DOGE/USD': '0.10000000' };
const WIRE = '0|DEPOSIT|0|JDOG|1|7;EXECUTE|0|7|claim';

function batchRun(fees, extra){
    return Object.assign({ status: 'valid', xchainFee: null, batchFees: fees,
        subCommands: [{ action: 'DEPOSIT', status: 'valid' }, { action: 'EXECUTE', status: 'valid' }] }, extra);
}

async function quoteAt(activation, dryRun, feeOutputSats){
    const before = process.env[EXECUTE_GATE];
    if(activation === null) delete process.env[EXECUTE_GATE];
    else process.env[EXECUTE_GATE] = String(activation);
    try {
        let util = makeUtil('DOGE', FEE_DEST);
        let built = makeCtx(util, makeDb({ prices: DOGE_PRICES, blockIndex: 100 }), { dryRun });
        let request = { action: 'BATCH', params: WIRE, source: 'src' };
        if(feeOutputSats !== undefined) request.feeOutputSats = feeOutputSats;
        return { quote: await built.ctx.computeFeeQuote.call(built.ctx, request), built, util };
    } finally {
        if(before === undefined) delete process.env[EXECUTE_GATE];
        else process.env[EXECUTE_GATE] = before;
    }
}

async function validateLegs(util, sats){
    let db = makeDb({ prices: DOGE_PRICES, blockIndex: 100 });
    let data = { BLOCK_INDEX: 100, BLOCK_TIME: 1000, TX_OUTPUTS: [
        { address: FEE_DEST, value: util.bcdiv(sats, 100000000, 8) }],
        BATCH_VALUE_LEDGER: { nativeFeeConsumed: '0' } };
    let first = await util.validateNativeCoinFee(data, { AMOUNT: '1.00000000' }, db, data.TX_OUTPUTS);
    let second = await util.validateNativeCoinFee(data, { AMOUNT: '0.01000000' }, db, data.TX_OUTPUTS);
    return { first, second };
}

describe('mandatory-native BATCH fee quote @regression @tier1', function () {
    it('quotes DOGE DEPOSIT then EXECUTE at or above the exact accepted boundary', async function () {
        let run = batchRun([{ action: 'DEPOSIT', xchainFee: '1' }, { action: 'EXECUTE', xchainFee: '9' }]);
        let { quote, util } = await quoteAt(null, run);
        let floorSats = Number(util.bcformat(util.bcmul(quote.minAcceptable, 100000000, 0), 0));
        let recommended = await validateLegs(util, quote.requiredFeeSats);
        let exact = await validateLegs(util, floorSats);
        let short = await validateLegs(util, floorSats - 1);
        assert(quote.requiredFeeSats >= floorSats, 'the recommendation never sits below the floor');
        assert.strictEqual(recommended.first.valid, true);
        assert.strictEqual(recommended.second.valid, true);
        assert.strictEqual(exact.first.valid, true);
        assert.strictEqual(exact.second.valid, true);
        assert.strictEqual(short.second.valid, false);
        assert.strictEqual(quote.xchainFee, '1.01000000');
        let airdropRun = batchRun([{ action: 'AIRDROP', xchainFees: ['1', '1'] }],
            { subCommands: [{ action: 'AIRDROP', status: 'valid' }] });
        let airdrop = await quoteAt(null, airdropRun);
        assert.strictEqual(airdrop.quote.xchainFee, '2.00000000');
        assert.strictEqual(airdrop.quote.minAcceptable, '19.50000000');
        assert(Number(airdrop.quote.requiredFeeNative) >= 19.5, 'the AIRDROP recommendation clears its floor');
    });
});

describe('mandatory-native BATCH fee quote @regression @tier1', function () {
    it('uses one literal-wire run and its sequential second-leg fee', async function () {
        let run = batchRun([{ action: 'DEPOSIT', xchainFee: '1' }, { action: 'SEND', xchainFee: '7' }]);
        let { quote, built } = await quoteAt(null, run);
        assert.strictEqual(built.calls.dryRuns, 1);
        assert.strictEqual(built.calls.dryRunArgs.rawData, 'BATCH|' + WIRE);
        assert.strictEqual(built.calls.dryRunArgs.batchFeeQuote, true);
        assert.strictEqual(quote.xchainFee, '8.00000000');
    });

    it('prices EXECUTE below and at the metered-gas gate', async function () {
        let run = batchRun([{ action: 'DEPOSIT', xchainFee: '1' }, { action: 'EXECUTE', xchainFee: '0.5' }]);
        let below = await quoteAt(101, run);
        let active = await quoteAt(100, run);
        assert.strictEqual(below.quote.xchainFee, '1.01000000');
        assert.strictEqual(active.quote.xchainFee, '1.60000000');
        assert.strictEqual(active.quote.gasSafetyMarginPercent, 20);
    });

    it('returns no-verdict for an incomplete whole-batch run', async function () {
        let run = batchRun(null, { status: null, error: 'handler threw: timed out' });
        let { quote } = await quoteAt(null, run);
        assert.strictEqual(quote.valid, null);
        assert.strictEqual(quote.noVerdict, true);
        assert.strictEqual(quote.requiredFeeSats, undefined);
        let invalidRun = batchRun(null, { status: 'invalid: COMMAND (empty)', error: null });
        let invalid = await quoteAt(null, invalidRun);
        assert.strictEqual(invalid.quote.valid, false);
        assert.strictEqual(invalid.quote.noVerdict, undefined);
    });

    it('keeps XEXEC and non-pricing sub-commands refused', async function () {
        let util = makeUtil('DOGE', FEE_DEST);
        let top = makeCtx(util, makeDb({ prices: DOGE_PRICES }));
        let xexec = await top.ctx.computeFeeQuote.call(top.ctx,
            { action: 'XEXEC', params: '0|x', source: 'src' });
        let forbidden = await top.ctx.computeFeeQuote.call(top.ctx,
            { action: 'BATCH', params: '0|DEPLOY|0|code', source: 'src' });
        let guardedRun = batchRun([], { subCommands: [
            { action: 'SEND', status: null, refused: 'controller guard not run' }] });
        let guarded = await quoteAt(null, guardedRun);
        assert.strictEqual(xexec.supported, false);
        assert.strictEqual(forbidden.deniedSubAction, 'DEPLOY');
        assert.strictEqual(guarded.quote.deniedSubAction, 'SEND');
        assert.strictEqual(top.calls.dryRuns, 0);
    });
});

describe('BATCH quote dispatch exception @regression @tier1', function () {
    it('allows only EXECUTE through the quote-specific pre-scan', function () {
        let util = makeUtil('DOGE', FEE_DEST);
        let ctx = makeCtx(util, makeDb({ prices: DOGE_PRICES })).ctx;
        assert.strictEqual(ctx.batchProbeForbiddenSubAction(['0', 'EXECUTE|0|7|m'], true), null);
        assert.strictEqual(ctx.batchProbeForbiddenSubAction(['0', 'XEXEC|0|7|m'], true), 'XEXEC');
        assert.strictEqual(Actions.isBatchProbeForbiddenSubAction('EXECUTE'), true);
    });
});
