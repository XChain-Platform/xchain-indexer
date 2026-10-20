// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The dry-run reads the chain tip only once it holds the block-loop transaction mutex.
//
// A tip read taken before beginTransaction races the block loop twice over: a bare read
// routes through getConnection() to the block's OPEN transaction (a dirty read of a height
// that may never commit), and a block that commits while the dry-run waits on the mutex
// leaves the synthetic transaction running against the new state at the old height.

const assert = require('assert');

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const Utility       = require('../../../src/utility.js');
const Actions       = require('../../../src/actions/index.js');
const PreflightMemo = require('../../../src/chain/preflight_memo.js');

// A dry-run context whose tip moves from 100 to 101 while beginTransaction waits.
function makeCtx({ tipThrows = false } = {}){
    let util  = new Utility();
    util.config['COIN'] = 'BTC';
    let calls = { order: [], rollback: 0, tx: null };
    let tip   = 100;
    let ctx = {
        util,
        config: util.config,
        indexerDb: {
            getLatestBlockIndex: async () => {
                calls.order.push('tip:' + tip);
                if(tipThrows && tip === 101) throw new Error('tip read exploded');
                return tip;
            },
            getBlockTime:        async (b) => { calls.order.push('time:' + b); return b * 10; },
            // A block commits while the dry-run is queued on the mutex.
            beginTransaction:    async () => { calls.order.push('begin'); tip = 101; },
            rollbackTransaction: async () => { calls.rollback++; calls.order.push('rollback'); },
            currentTxEpoch:      () => 0,
            runInTxEpoch:        (epoch, fn) => fn(),
            runInDryRunEpoch:    (epoch, fn) => fn(),
            getFeeRecord:        async () => null
        },
        processTransaction: async (tx) => {
            calls.order.push('process');
            calls.tx = tx;
            return { STATUS: 'valid', ACTION_INDEX: 5 };
        },
        dryRunAction: Actions.prototype.dryRunAction
    };
    ctx.config['BLOCK_PROCESS_TIMEOUT'] = 300000;
    return { ctx, calls };
}

const REQUEST = { action: 'ISSUE', params: ['0', 'T'], source: 's', timeoutMs: 300000 };

describe('dry-run reads the tip under the transaction mutex @regression @tier1', function () {

    it('reads the tip and block time only after beginTransaction', async function () {
        let { ctx, calls } = makeCtx();
        await ctx.dryRunAction.call(ctx, REQUEST);
        assert.deepStrictEqual(calls.order.slice(0, 3), ['begin', 'tip:101', 'time:101'],
            'a tip read before the mutex can dirty-read the block loop\'s open transaction');
    });

    it('runs the synthetic transaction at the height the state it reads was committed at', async function () {
        let { ctx, calls } = makeCtx();
        let r = await ctx.dryRunAction.call(ctx, REQUEST);
        assert.strictEqual(calls.tx.block_index, 101, 'the block that committed during the wait is the run\'s height');
        assert.strictEqual(calls.tx.block_time, 1010);
        assert.strictEqual(r.blockIndex, 101);
        assert.strictEqual(r.blockTime, 1010);
    });

    it('a failed tip read propagates as an error, after exactly one rollback, and runs nothing', async function () {
        let { ctx, calls } = makeCtx({ tipThrows: true });
        await assert.rejects(() => ctx.dryRunAction.call(ctx, REQUEST), /tip read exploded/,
            'an infrastructure failure must not be reported as a handler verdict');
        assert.strictEqual(calls.rollback, 1, 'the opened transaction is rolled back once');
        assert.ok(calls.order.indexOf('process') === -1, 'no handler runs without a height');
    });

    it('the normal path still rolls back exactly once', async function () {
        let { ctx, calls } = makeCtx();
        await ctx.dryRunAction.call(ctx, REQUEST);
        assert.strictEqual(calls.rollback, 1);
        assert.strictEqual(calls.order[calls.order.length - 1], 'rollback');
    });
});

describe('dry-run reads the tip under the transaction mutex @regression @tier1', function () {

    // computePreflight over a stubbed engine whose run lands one block past the pre-read tip.
    function makePreflightCtx(){
        let util = new Utility();
        util.config['COIN'] = 'BTC';
        util.config['GAS']  = 'XCHAIN';
        let ctx = {
            config:    util.config,
            util:      util,
            actionAliases: {},
            indexerDb: { getLatestBlockIndex: async () => 100, getBlockTime: async () => 1000 },
            _preflightMemo: new PreflightMemo(8),
            _feeQuotePending: 0,
            dryRunAction: async () => ({ blockIndex: 101, blockTime: 1010, status: 'valid', error: null,
                                         xchainFee: '0', sourceFeeBalance: null,
                                         subCommands: null, oracleFeesOwed: null }),
            nativeFeeMandatory: Actions.prototype.nativeFeeMandatory,
            batchProbeForbiddenSubAction: Actions.prototype.batchProbeForbiddenSubAction,
            computePreflight: Actions.prototype.computePreflight
        };
        return ctx;
    }

    it('files the memo entry under the height the verdict was computed at', async function () {
        let ctx = makePreflightCtx();
        let r = await ctx.computePreflight({ action: 'SEND', params: '0|JDOG|1|addr1', source: 's', feeMode: 'xchain' });
        assert.strictEqual(r.blockIndex, 101);
        let at101 = ctx._preflightMemo.get(ctx._preflightMemo.key('SEND', ['0', 'JDOG', '1', 'addr1'], 's', 101, 'xchain'));
        let at100 = ctx._preflightMemo.get(ctx._preflightMemo.key('SEND', ['0', 'JDOG', '1', 'addr1'], 's', 100, 'xchain'));
        assert.ok(at101, 'the verdict is served at the height it answers for');
        assert.strictEqual(at100, null, 'a verdict computed at 101 must not be served as 100\'s');
    });
});
