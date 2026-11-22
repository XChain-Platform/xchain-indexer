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
// VM actions (EXECUTE, DEPLOY and its chunk carriers) debit GAS without a fees row. The raw
// dry-run quote must report the debit the handler disclosed, and must read a VM action with
// no disclosed figure as unknown (null), never as free ('0').

const assert = require('assert');

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const Utility = require('../../../../src/utility.js');
const Actions = require('../../../../src/actions/index.js');
const { makeIndexerDb } = require('./helpers/indexer_db.js');

const FEE_DEST = 'feeDestinationAddr111111111111111';
const BTC_PRICES = { 'XCHAIN/USD': '1.00000000', 'BTC/USD': '50000.00000000' };

// The real dryRunAction / computeFeeQuoteDryRun over a stubbed handler run that returns
// `status` and, when given, the handler's PROBE_SETTLED_GAS_FEE; no fees row is staged.
function makeCtx({ status = 'valid', settledGasFee, prices = {} } = {}){
    let calls = { order: [], begin: 0, rollback: 0, processed: null, createdAddresses: 0 };
    let util  = new Utility();
    util.config['COIN']                         = 'BTC';
    util.config['ADDRESS']                      = Object.assign({}, util.config['ADDRESS'] || {}, { FEE_DESTINATION: FEE_DEST });
    util.config['FEE_TOLERANCE_MIN']            = '0.95';
    util.config['FEE_TOLERANCE_MAX']            = '1.10';
    util.config['ORACLE_MAX_PRICE_AGE_SECONDS'] = 1800;
    util.config['BLOCK_PROCESS_TIMEOUT']        = 300000;
    let opts = { feeAmount: null, prices, addressId: 7, tickId: 3, addressBalances: { 3: '19898' }, balanceThrows: false };
    let ctx = {
        util,
        config: util.config,
        indexerDb: makeIndexerDb(opts, calls),
        processTransaction: async (tx) => {
            calls.processed = tx;
            ctx.util.resetGuardGasTotals();
            let result = { STATUS: status, ACTION: tx.data.split('|')[0], ACTION_INDEX: 55, SOURCE: tx.source };
            if(settledGasFee !== undefined) result['PROBE_SETTLED_GAS_FEE'] = settledGasFee;
            return result;
        },
        dryRunAction:          Actions.prototype.dryRunAction,
        priceFeeQuote:         Actions.prototype.priceFeeQuote,
        computeFeeQuoteDryRun: Actions.prototype.computeFeeQuoteDryRun
    };
    return ctx;
}

const run = (ctx, action) =>
    ctx.dryRunAction.call(ctx, { action, params: ['0'], source: 'src1', timeoutMs: 300000 });

describe('_dryRunAction VM settled gas fee', () => {

    it('reports the settled debit of a DEPLOY, which writes no fees row', async () => {
        let r = await run(makeCtx({ settledGasFee: '1.05580000' }), 'DEPLOY');
        assert.strictEqual(r.status, 'valid');
        assert.strictEqual(r.xchainFee, '1.05580000');
    });

    it('reads a DEPLOY with no disclosed figure as unknown, never free', async () => {
        let r = await run(makeCtx({}), 'DEPLOY');
        assert.strictEqual(r.status, 'valid');
        assert.strictEqual(r.xchainFee, null);
    });

    it('reports what a reverted EXECUTE still pays', async () => {
        let r = await run(makeCtx({ status: 'reverted', settledGasFee: '0.50000000' }), 'EXECUTE');
        assert.strictEqual(r.status, 'reverted');
        assert.strictEqual(r.xchainFee, '0.50000000');
    });

    it('keeps a valid non-VM action with no fees row at zero', async () => {
        let r = await run(makeCtx({}), 'MINT');
        assert.strictEqual(r.xchainFee, '0');
    });
});

describe('computeFeeQuoteDryRun VM settled gas fee', () => {

    it('prices a non-zero native fee for a valid charged EXECUTE', async () => {
        let ctx = makeCtx({ settledGasFee: '0.50000000', prices: BTC_PRICES });
        let r = await ctx.computeFeeQuoteDryRun.call(ctx, { action: 'EXECUTE', params: ['0'], source: 'src1' });
        assert.strictEqual(r.valid, true);
        assert.strictEqual(r.xchainFee, '0.50000000');
        assert.strictEqual(r.feeSupported, true);
        assert.strictEqual(r.requiredFeeNative, '0.00001000');
    });

    it('sizes no native fee for a reverted EXECUTE but still discloses its debit', async () => {
        let ctx = makeCtx({ status: 'reverted', settledGasFee: '0.50000000', prices: BTC_PRICES });
        let r = await ctx.computeFeeQuoteDryRun.call(ctx, { action: 'EXECUTE', params: ['0'], source: 'src1' });
        assert.strictEqual(r.valid, false);
        assert.strictEqual(r.xchainFee, '0.50000000');
        assert.strictEqual(r.feeSupported, false);
        assert.strictEqual(r.requiredFeeNative, null);
    });

    it('sizes no native fee for a valid EXECUTE with no disclosed figure', async () => {
        let ctx = makeCtx({ prices: BTC_PRICES });
        let r = await ctx.computeFeeQuoteDryRun.call(ctx, { action: 'EXECUTE', params: ['0'], source: 'src1' });
        assert.strictEqual(r.valid, true);
        assert.strictEqual(r.xchainFee, null);
        assert.strictEqual(r.feeSupported, false);
    });
});
