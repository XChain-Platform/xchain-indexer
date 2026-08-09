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
// . The public fee quote used to time-box only its dry-run, never the wait in front
// of it: beginTransaction queues on the block-processing transaction mutex, so a quote that
// arrived during a slow block waited out the whole block (25-40s measured on the BTC regtest
// venue), blew the explorer's 5s hop and came back to the wallet as a bare 502. These tests
// pin the bounded wait, the give-up answer, and the mutex invariant that makes the give-up
// safe: a lock handed to a caller that already gave up is never released again.

const assert = require('assert');

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const Utility  = require('../../src/utility.js');
const Actions  = require('../../src/actions.js');
const Database = require('../../src/db.js');

const FEE_DEST = 'feeDestinationAddr111111111111111';

// A bare mutex over the real prototype methods: the lock is pure state plus these two
// functions, and standing up a Database needs a live MariaDB.
function makeLock(){
    let ctx = Object.create(Database.prototype);
    ctx._txLock = { locked: false, queue: [] };
    return ctx;
}

function busyError(){
    let e = new Error('transaction lock busy: waited 2000ms for the database transaction mutex');
    e.code = 'TX_LOCK_BUSY';
    return e;
}

// Actions-like context exposing the real computeFeeQuote / computePreflight with the dry-run
// engine stubbed to whatever the test needs (the engine itself lives in feeQuoteDryRun.test.js).
function makeQuoteCtx({ dryRunThrows = null } = {}){
    let util = new Utility();
    util.config['COIN']                         = 'BTC';
    util.config['ADDRESS']                      = Object.assign({}, util.config['ADDRESS'] || {}, { FEE_DESTINATION: FEE_DEST });
    util.config['FEE_TOLERANCE_MIN']            = '0.95';
    util.config['FEE_TOLERANCE_MAX']            = '1.10';
    util.config['ORACLE_MAX_PRICE_AGE_SECONDS'] = 1800;
    util.config['GAS']                          = 'XCHAIN';

    let calls = { dryRuns: 0, dryRunArgs: null, memoSets: 0 };
    let ctx = {
        config:    util.config,
        util:      util,
        _calls:    calls,
        actionAliases: {},
        indexerDb: {
            getLatestBlockIndex: async () => 100,
            getBlockTime:        async () => 1000,
            getLatestPrice:      async () => null
        },
        protocolChanges: { isEnabled: async () => true },
        _preflightMemo: {
            key: (...a) => a.join('|'),
            get: () => null,
            set: () => { calls.memoSets++; }
        },
        _dryRunAction: async (args) => {
            calls.dryRuns++;
            calls.dryRunArgs = args;
            if(dryRunThrows) throw dryRunThrows();
            return { blockIndex: 100, blockTime: 1000, status: 'valid', error: null, xchainFee: '0', sourceFeeBalance: null };
        },
        _nativeFeeMandatory: Actions.prototype._nativeFeeMandatory,
        _priceFeeQuote:      Actions.prototype._priceFeeQuote,
        _staticFeeQuote:     Actions.prototype._staticFeeQuote,
        computeFeeQuote:     Actions.prototype.computeFeeQuote,
        computePreflight:    Actions.prototype.computePreflight
    };
    return { ctx, calls };
}

describe('fee-quote transaction-lock budget ', function () {

    describe('_acquireTxLock() bounded wait', function () {

        it('takes a free lock immediately even with a budget', async function () {
            let db = makeLock();
            await db._acquireTxLock(50);
            assert.strictEqual(db._txLock.locked, true);
        });

        it('resolves normally when the holder releases inside the budget', async function () {
            let db = makeLock();
            await db._acquireTxLock();                       // holder
            let waiting = db._acquireTxLock(1000);
            setTimeout(() => db._releaseTxLock(), 10);
            await waiting;                                    // must not reject
        });

        it('rejects TX_LOCK_BUSY when the holder keeps the lock past the budget', async function () {
            let db = makeLock();
            await db._acquireTxLock();                       // holder never releases
            let started = Date.now();
            await assert.rejects(
                () => db._acquireTxLock(30),
                (e) => e.code === 'TX_LOCK_BUSY' && /transaction lock busy/.test(e.message));
            assert.ok(Date.now() - started < 1000, 'gave up in the budget, not in block-time');
        });

        it('an unbounded waiter still waits (the block loop must never give up)', async function () {
            let db = makeLock();
            await db._acquireTxLock();
            let settled = false;
            let waiting = db._acquireTxLock().then(() => { settled = true; });
            await new Promise(r => setTimeout(r, 60));
            assert.strictEqual(settled, false, 'no budget means no give-up');
            db._releaseTxLock();
            await waiting;
            assert.strictEqual(settled, true);
        });

        // The invariant that makes giving up safe: _releaseTxLock hands the lock to a LIVE
        // waiter. Granting it to one that already rejected would leave the mutex held with
        // nothing left to release it, wedging block processing permanently.
        it('a release skips a timed-out waiter and grants the next live one', async function () {
            let db = makeLock();
            await db._acquireTxLock();
            let gaveUp = db._acquireTxLock(20).then(() => 'granted', (e) => e.code);
            let live   = false;
            let second = db._acquireTxLock().then(() => { live = true; });
            assert.strictEqual(await gaveUp, 'TX_LOCK_BUSY');
            db._releaseTxLock();
            await second;
            assert.strictEqual(live, true, 'the live waiter got the lock');
            assert.strictEqual(db._txLock.locked, true, 'lock is held by the live waiter');
        });

        it('a release with only dead waiters leaves the lock FREE, not stranded', async function () {
            let db = makeLock();
            await db._acquireTxLock();
            let gaveUp = db._acquireTxLock(20).then(() => 'granted', (e) => e.code);
            assert.strictEqual(await gaveUp, 'TX_LOCK_BUSY');
            db._releaseTxLock();
            assert.strictEqual(db._txLock.locked, false, 'mutex released, not held by a ghost');
            await db._acquireTxLock(50);                       // a fresh caller can take it
            assert.strictEqual(db._txLock.locked, true);
        });
    });

    describe('_dryRunAction() passes the budget to the mutex', function () {

        function makeDryRunCtx({ acquireRejects = false } = {}){
            let calls = { begin: 0, beginOpts: null, rollback: 0 };
            let util  = new Utility();
            util.config['COIN'] = 'BTC';
            let ctx = {
                util,
                config: util.config,
                _calls: calls,
                indexerDb: {
                    getLatestBlockIndex: async () => 100,
                    getBlockTime:        async () => 1000,
                    beginTransaction:    async (opts) => {
                        calls.begin++;
                        calls.beginOpts = opts;
                        if(acquireRejects) throw busyError();
                    },
                    rollbackTransaction: async () => { calls.rollback++; },
                    currentTxEpoch:      () => 0,
                    runInTxEpoch:        (epoch, fn) => fn(),
                    getFeeRecord:        async () => ({ amount: '1.00000000' })
                },
                processTransaction: async () => ({ STATUS: 'valid', ACTION_INDEX: 5 }),
                _dryRunAction: Actions.prototype._dryRunAction
            };
            ctx.config['BLOCK_PROCESS_TIMEOUT'] = 300000;
            return { ctx, calls };
        }

        it('forwards acquireTimeoutMs to beginTransaction', async function () {
            let { ctx, calls } = makeDryRunCtx();
            await ctx._dryRunAction.call(ctx, { action: 'ISSUE', params: ['0', 'T'], source: 's', timeoutMs: 300000, acquireTimeoutMs: 1234 });
            assert.deepStrictEqual(calls.beginOpts, { acquireTimeoutMs: 1234 });
        });

        it('leaves acquireTimeoutMs undefined when the caller sets none (block-loop parity)', async function () {
            let { ctx, calls } = makeDryRunCtx();
            await ctx._dryRunAction.call(ctx, { action: 'ISSUE', params: ['0', 'T'], source: 's', timeoutMs: 300000 });
            assert.deepStrictEqual(calls.beginOpts, { acquireTimeoutMs: undefined });
        });

        it('a give-up opens no transaction, so it never rolls one back', async function () {
            let { ctx, calls } = makeDryRunCtx({ acquireRejects: true });
            await assert.rejects(
                () => ctx._dryRunAction.call(ctx, { action: 'ISSUE', params: ['0', 'T'], source: 's', timeoutMs: 300000, acquireTimeoutMs: 10 }),
                (e) => e.code === 'TX_LOCK_BUSY');
            assert.strictEqual(calls.rollback, 0, 'no rollback for a transaction that never opened');
        });
    });

    describe('computeFeeQuote() answers busy instead of waiting out a block', function () {

        it('passes the acquire budget down to the dry-run', async function () {
            let { ctx, calls } = makeQuoteCtx();
            await ctx.computeFeeQuote.call(ctx, { action: 'ISSUE', params: '0|NEWTOK' });
            assert.strictEqual(calls.dryRunArgs.acquireTimeoutMs, 2000, 'default budget is under the explorer 5s hop');
        });

        it('honours INDEXER_FEEQUOTE_ACQUIRE_TIMEOUT_MS', async function () {
            let prev = process.env.INDEXER_FEEQUOTE_ACQUIRE_TIMEOUT_MS;
            process.env.INDEXER_FEEQUOTE_ACQUIRE_TIMEOUT_MS = '750';
            try {
                let { ctx, calls } = makeQuoteCtx();
                await ctx.computeFeeQuote.call(ctx, { action: 'ISSUE', params: '0|NEWTOK' });
                assert.strictEqual(calls.dryRunArgs.acquireTimeoutMs, 750);
            } finally {
                if(prev === undefined) delete process.env.INDEXER_FEEQUOTE_ACQUIRE_TIMEOUT_MS;
                else process.env.INDEXER_FEEQUOTE_ACQUIRE_TIMEOUT_MS = prev;
            }
        });

        it('returns a retryable busy quote (not a throw) when the mutex give-up fires', async function () {
            let { ctx } = makeQuoteCtx({ dryRunThrows: busyError });
            let q = await ctx.computeFeeQuote.call(ctx, { action: 'ISSUE', params: '0|NEWTOK' });
            assert.strictEqual(q.busy, true);
            assert.strictEqual(q.retryable, true);
            assert.strictEqual(q.valid, false);
            assert.strictEqual(q.retryAfterMs, 2000);
            assert.match(q.error, /processing a block/);
            assert.strictEqual(q.action, 'ISSUE', 'still a well-formed quote envelope');
        });

        it('releases the admission slot on the busy path', async function () {
            let { ctx } = makeQuoteCtx({ dryRunThrows: busyError });
            await ctx.computeFeeQuote.call(ctx, { action: 'ISSUE', params: '0|NEWTOK' });
            await ctx.computeFeeQuote.call(ctx, { action: 'ISSUE', params: '0|NEWTOK' });
            assert.strictEqual(ctx._feeQuotePending, 0, 'the pending counter is not leaked by the give-up');
        });

        it('any other dry-run failure still throws (only the mutex give-up is absorbed)', async function () {
            let { ctx } = makeQuoteCtx({ dryRunThrows: () => new Error('engine boom') });
            await assert.rejects(
                () => ctx.computeFeeQuote.call(ctx, { action: 'ISSUE', params: '0|NEWTOK' }),
                /engine boom/);
        });
    });

    describe('computePreflight() gives up on the same terms', function () {

        it('returns busy/retryable with valid null, and memoizes nothing', async function () {
            let { ctx, calls } = makeQuoteCtx({ dryRunThrows: busyError });
            let p = await ctx.computePreflight.call(ctx, { action: 'ISSUE', params: '0|NEWTOK', source: 'src' });
            assert.strictEqual(p.busy, true);
            assert.strictEqual(p.retryable, true);
            assert.strictEqual(p.valid, null, 'busy is the absence of a verdict, not a negative one');
            assert.strictEqual(calls.memoSets, 0, 'a busy answer must never be cached as a verdict');
        });

        it('passes the acquire budget down to the dry-run', async function () {
            let { ctx, calls } = makeQuoteCtx();
            await ctx.computePreflight.call(ctx, { action: 'ISSUE', params: '0|NEWTOK', source: 'src' });
            assert.strictEqual(calls.dryRunArgs.acquireTimeoutMs, 2000);
        });
    });
});
