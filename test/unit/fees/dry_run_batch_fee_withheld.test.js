// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// A dry-run of a BATCH reports no single fee figure.
//
// The batch hands its record to each sub-command in turn (prepareSubCommand gives each its
// own ACTION_INDEX and BATCH_POSITION), so after the loop ACTION_INDEX names the LAST
// sub-command's row. Reading that one fee row answered for one command, not the batch: the
// pre-flight showed it as the batch's fee and judged feeAffordable against it, and the raw
// feequotedryrun priced a native output from it.

const assert = require('assert');

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const Utility       = require('../../../src/utility.js');
const Actions       = require('../../../src/actions/index.js');
const PreflightMemo = require('../../../src/chain/preflight_memo.js');

const FEE_DEST = 'feeDestinationAddr111111111111111';
const LAST_SUB_INDEX = 9;

// The record a valid BATCH leaves after its dispatch loop: the last sub-command's index.
function batchRecord(){
    return { ACTION: 'SEND', STATUS: 'valid', ACTION_INDEX: LAST_SUB_INDEX, BATCH_POSITION: 1 };
}

function makeCtx({ record, feeAmount = '0.40000000', balance = '0.50000000' } = {}){
    let util = new Utility();
    util.config['COIN']    = 'BTC';
    util.config['GAS']     = 'XCHAIN';
    util.config['ADDRESS'] = Object.assign({}, util.config['ADDRESS'] || {}, { FEE_DESTINATION: FEE_DEST });
    let calls = { feeReads: [], priced: 0 };
    let ctx = {
        util,
        config: util.config,
        actionAliases: {},
        _preflightMemo: new PreflightMemo(8),
        _feeQuotePending: 0,
        indexerDb: {
            getLatestBlockIndex: async () => 100,
            getBlockTime:        async () => 1000,
            beginTransaction:    async () => {},
            rollbackTransaction: async () => {},
            currentTxEpoch:      () => 0,
            runInTxEpoch:        (epoch, fn) => fn(),
            runInDryRunEpoch:    (epoch, fn) => fn(),
            getFeeRecord:        async (ai) => {
                calls.feeReads.push(ai);
                return (feeAmount == null) ? null : { amount: feeAmount, payment_mode: 1 };
            },
            getAddressId:        async () => 7,
            getTickerId:         async () => 1,
            getAddressBalances:  async () => ({ 1: balance })
        },
        processTransaction: async () => Object.assign({}, record),
        priceFeeQuote: async (base) => { calls.priced++; return Object.assign(base, { valid: true, requiredFeeSats: 1 }); },
        dryRunAction:          Actions.prototype.dryRunAction,
        nativeFeeMandatory:    Actions.prototype.nativeFeeMandatory,
        batchProbeForbiddenSubAction: Actions.prototype.batchProbeForbiddenSubAction,
        computePreflight:      Actions.prototype.computePreflight,
        computeFeeQuoteDryRun: Actions.prototype.computeFeeQuoteDryRun
    };
    ctx.config['BLOCK_PROCESS_TIMEOUT'] = 300000;
    return { ctx, calls };
}

const RUN = { action: 'BATCH', params: ['0', 'SEND', '0', 'J', '1', 'a;SEND', '0', 'J', '2', 'b'], source: 's', timeoutMs: 300000 };

describe('a BATCH dry-run withholds the single fee figure @regression @tier1', function () {

    it('reports xchainFee null, not the last sub-command\'s fee', async function () {
        let { ctx, calls } = makeCtx({ record: batchRecord() });
        let r = await ctx.dryRunAction.call(ctx, RUN);
        assert.strictEqual(r.status, 'valid');
        assert.strictEqual(r.xchainFee, null, 'the last sub-command\'s fee is not the batch\'s');
        assert.deepStrictEqual(calls.feeReads, [], 'no fee row answers for the batch, so none is read');
    });

    it('reports null, not "0", when the last sub-command happened to be free', async function () {
        let { ctx } = makeCtx({ record: batchRecord(), feeAmount: null });
        let r = await ctx.dryRunAction.call(ctx, RUN);
        assert.strictEqual(r.xchainFee, null, '"0" would tell a confirm screen the batch is free');
    });

    it('still reads the fee row of a non-batch action', async function () {
        let { ctx, calls } = makeCtx({ record: { ACTION: 'SEND', STATUS: 'valid', ACTION_INDEX: 5 } });
        let r = await ctx.dryRunAction.call(ctx, { action: 'SEND', params: ['0', 'J', '1', 'a'], source: 's', timeoutMs: 300000 });
        assert.deepStrictEqual(calls.feeReads, [5]);
        assert.strictEqual(r.xchainFee, '0.40000000');
    });

    it('still reads the own row of a batch that never dispatched (invalid as a whole)', async function () {
        let { ctx, calls } = makeCtx({ record: { ACTION: 'BATCH', STATUS: 'invalid: BATCH (x)', ACTION_INDEX: 3 }, feeAmount: null });
        let r = await ctx.dryRunAction.call(ctx, RUN);
        assert.deepStrictEqual(calls.feeReads, [3]);
        assert.strictEqual(r.xchainFee, null);
    });
});

describe('a BATCH dry-run withholds the single fee figure @regression @tier1', function () {

    it('the pre-flight answers xchainFee and feeAffordable null instead of a false PASS', async function () {
        // The payer holds 0.5 and the last sub-command cost 0.4: the old answer said affordable.
        let { ctx } = makeCtx({ record: batchRecord() });
        let r = await ctx.computePreflight({ action: 'BATCH', params: '0|SEND|0|J|1|a;SEND|0|J|2|b', source: 's', feeMode: 'xchain' });
        assert.strictEqual(r.valid, true);
        assert.strictEqual(r.xchainFee, null);
        assert.strictEqual(r.feeAffordable, null, 'affordability judged against one command\'s fee is a false PASS');
        assert.strictEqual(r.feeTokenBalance, '0.50000000', 'the balance itself is still reported');
    });

    it('feequotedryrun prices no native output for a batch rather than pricing zero', async function () {
        let { ctx, calls } = makeCtx({ record: batchRecord() });
        let r = await ctx.computeFeeQuoteDryRun({ action: 'BATCH', params: '0|SEND|0|J|1|a;SEND|0|J|2|b', source: 's' });
        assert.strictEqual(r.valid, true);
        assert.strictEqual(r.xchainFee, null);
        assert.strictEqual(calls.priced, 0, 'pricing a null fee prices zero, an under-sized output');
        assert.strictEqual(r.feeSupported, false);
        assert.strictEqual(r.requiredFeeNative, null);
    });

    it('feequotedryrun still prices a non-batch action', async function () {
        let { ctx, calls } = makeCtx({ record: { ACTION: 'SEND', STATUS: 'valid', ACTION_INDEX: 5 } });
        let r = await ctx.computeFeeQuoteDryRun({ action: 'SEND', params: '0|J|1|a', source: 's' });
        assert.strictEqual(r.xchainFee, '0.40000000');
        assert.strictEqual(calls.priced, 1);
        assert.strictEqual(r.feeSupported, true);
    });
});
