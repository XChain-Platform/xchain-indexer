/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Public quote surfaces refuse an action name dispatch would re-split
 *
 * The dry-run joins action and params on '|' and processTransaction splits them again,
 * so 'EXECUTE|0|...' would classify as one quotable name and dispatch as EXECUTE.
 ********************************************************************/

const assert = require('assert');

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const Actions       = require('../../../../src/actions/index.js');
const PreflightMemo = require('../../../../src/chain/preflight_memo.js');
const { makeUtil, makeDb, makeCtx, FEE_DEST, BTC_PRICES } = require('./helpers/quote_ctx.js');

// Names that carry a second action after a pipe, or padding the pipe split would strip
const PIPED = ['EXECUTE|0|contract|method', 'DEPLOY|0|code', 'ATTEST|1|x', 'XEXEC|0',
               'execute|0', 'EXECUTE |0', 'SEND|0|EXECUTE', 'EXECUTE\t|0'];

// A pre-flight context with the real computePreflight and a counting dry-run stub
function preflightCtx(){
    let calls = { dryRuns: 0 };
    let util  = makeUtil('BTC', FEE_DEST);
    let ctx = {
        config: util.config, util: util,
        indexerDb: { getLatestBlockIndex: async () => 100, getBlockTime: async () => 1000 },
        actionAliases: { TRANSFER: 'SEND' },
        _preflightMemo: new PreflightMemo(4), _feeQuotePending: 0,
        dryRunAction: async () => { calls.dryRuns++; return { blockIndex: 100, blockTime: 1000, status: 'valid', error: null, xchainFee: '0', sourceFeeBalance: null }; },
        nativeFeeMandatory: Actions.prototype.nativeFeeMandatory,
        batchProbeForbiddenSubAction: Actions.prototype.batchProbeForbiddenSubAction,
        computePreflight: Actions.prototype.computePreflight
    };
    return { ctx, calls };
}

describe('public quote surfaces refuse piped action names @regression @security', function () {

    it('feequote never dry-runs a piped action name and never claims a verdict', async function () {
        for(let action of PIPED){
            let { ctx, calls } = makeCtx(makeUtil('BTC', FEE_DEST), makeDb({ prices: BTC_PRICES }));
            let q = await ctx.computeFeeQuote.call(ctx, { action, params: ['x'], source: 'src' });
            assert.strictEqual(calls.dryRuns, 0, JSON.stringify(action) + ' reached the dry-run');
            assert.strictEqual(q.supported, false, JSON.stringify(action) + ' supported');
            assert.strictEqual(q.valid, false, JSON.stringify(action) + ' valid');
        }
    });

    it('preflight never dry-runs a piped action name and leaves it unjudged', async function () {
        for(let action of PIPED){
            let { ctx, calls } = preflightCtx();
            let r = await ctx.computePreflight({ action, params: 'x' });
            assert.strictEqual(calls.dryRuns, 0, JSON.stringify(action) + ' reached the dry-run');
            assert.strictEqual(r.supported, false, JSON.stringify(action) + ' supported');
            assert.strictEqual(r.valid, null, JSON.stringify(action) + ' valid');
        }
    });

    it('a well-formed quotable name still reaches the dry-run on both surfaces', async function () {
        let { ctx, calls } = makeCtx(makeUtil('BTC', FEE_DEST), makeDb({ prices: BTC_PRICES }));
        await ctx.computeFeeQuote.call(ctx, { action: ' send ', params: ['0', 'FOO', '1', 'dest'], source: 'src' });
        assert.strictEqual(calls.dryRuns, 1);
        let pf = preflightCtx();
        await pf.ctx.computePreflight({ action: 'transfer', params: '0|FOO|1|dest' });
        assert.strictEqual(pf.calls.dryRuns, 1);
    });

    it('the shared classifier denies a piped or empty name instead of calling it quotable', function () {
        for(let action of PIPED.concat(['', 'A'.repeat(33)]))
            assert.strictEqual(Actions.classifyFeeQuoteAction(action), 'denied', JSON.stringify(action));
        assert.strictEqual(Actions.classifyFeeQuoteAction('SEND'), 'quotable');
        assert.strictEqual(Actions.classifyFeeQuoteAction('ATTEST'), 'exempt');
    });
});
