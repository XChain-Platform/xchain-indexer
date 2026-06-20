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
// Direct-hub-DB call-presence barrier (_waitForDirectCallPresence).
//
// Consensus-correctness regression guard. In single-host / direct-hub-DB mode the
// HubDbSync call barrier is skipped, so the indexer must independently ensure its
// local hub mirror covers a block before the cross-chain-call pass reads the table.
// The set injected at a block must be EXACTLY the finalized cross_chain_calls rows
// with effective_time <= block_time in canonical hub state. A node whose mirror lags
// would otherwise inject a SMALLER set and diverge the actions hash (a ledger fork).
//
// The barrier proceeds ONLY when the mirror covers block_time (MAX(effective_time)
// over finalized rows >= block_time, or the table is empty). When the mirror lags it
// DEFERS: it polls with a bounded sleep loop and throws on timeout so the caller
// retries the block, never proceeding with a partial set. The old wall-clock proceed
// (Date.now >= block_time) and proceed-on-timeout behaviors are gone; these tests pin
// the new behavior.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert         = require('assert');
const sinon          = require('sinon');
const XChainIndexer  = require('../../src/XChainIndexer.js');

const NOW_S = () => Math.floor(Date.now() / 1000);

function ctx(opts){
    opts = opts || {};
    let call = 0;
    const doQuery = sinon.stub().callsFake(async () => {
        if(opts.rowsSeq){
            const r = opts.rowsSeq[Math.min(call, opts.rowsSeq.length - 1)];
            call++;
            return r;
        }
        return opts.rows || [{ ts: null }];
    });
    return {
        hubDb: opts.noHubDb ? null : { doQuery },
        callPresenceTimeoutMs: opts.timeoutMs != null ? opts.timeoutMs : 10000,
        util: {
            sleep: (ms) => new Promise(r => setTimeout(r, ms)),
            throwError: (msg) => { throw new Error(msg); }
        },
        _doQuery: doQuery
    };
}

const run = (self, blockTime) =>
    XChainIndexer.prototype._waitForDirectCallPresence.call(self, blockTime);

describe('XChainIndexer._waitForDirectCallPresence (direct-hub-DB call barrier)', function(){

    afterEach(() => sinon.restore());

    it('is a no-op when no hub DB connection exists', async function(){
        const self = ctx({ noHubDb: true });
        await run(self, NOW_S() + 3600);                 // returns immediately, no hubDb to read
        assert.strictEqual(self.hubDb, null);
    });

    it('is a no-op for a non-finite block_time', async function(){
        const self = ctx();
        await run(self, NaN);
        assert.strictEqual(self._doQuery.called, false);
    });

    it('(fast path) proceeds at once when the hub mirror already covers block_time', async function(){
        // Single-shared-DB / current-mirror case: MAX(effective_time) >= block_time on the
        // first query, so the barrier returns with one query and no sleep (zero added latency).
        const bt = NOW_S();
        const self = ctx({ rows: [{ ts: bt + 5 }] });
        const started = Date.now();
        await run(self, bt);
        const elapsed = Date.now() - started;
        assert.strictEqual(self._doQuery.calledOnce, true);
        assert.ok(elapsed < 100, 'fast path must add no latency, took ' + elapsed + 'ms');
    });

    it('(fast path) proceeds at once when the hub holds no finalized calls (nothing to wait on)', async function(){
        // Empty table: nothing can be effective at/before block_time, so proceed immediately.
        const self = ctx({ rows: [{ ts: null }] });
        const started = Date.now();
        await run(self, NOW_S());
        assert.strictEqual(self._doQuery.calledOnce, true);
        assert.ok(Date.now() - started < 100);
    });

    it('(fast path) does NOT proceed on the wall-clock gate when the mirror is behind', async function(){
        // A past/replay block_time: the OLD code returned immediately via Date.now() without
        // a query. The fix removes that gate, so a behind mirror must still defer (throw),
        // never proceed with a partial set just because wall-clock passed block_time.
        const bt = NOW_S() - 5000;                       // well in the past
        const self = ctx({ rows: [{ ts: bt - 10 }], timeoutMs: 80 });
        let threw = false;
        try { await run(self, bt); } catch(e){ threw = true; }
        assert.ok(threw, 'must defer (throw) for a behind mirror, even for a past block_time');
        assert.ok(self._doQuery.called, 'must query the mirror, not short-circuit on wall-clock');
    });

    it('(defer) throws on timeout when the mirror never catches up (no partial-set proceed)', async function(){
        // Mirror always reports a watermark BELOW block_time: it is genuinely behind. The
        // barrier must NOT proceed; it polls within the bound and then throws so the caller
        // defers and retries the block.
        const bt = NOW_S() + 3600;
        const self = ctx({ rows: [{ ts: bt - 50 }], timeoutMs: 80 });
        const started = Date.now();
        let threw = false;
        try { await run(self, bt); } catch(e){ threw = true; }
        const elapsed = Date.now() - started;
        assert.ok(threw, 'must throw (defer) rather than proceed with a partial set');
        assert.ok(self._doQuery.callCount >= 1, 'should have polled the hub mirror');
        assert.ok(elapsed < 2000, 'must return shortly after the bound, not hang: ' + elapsed + 'ms');
    });

    it('(defer then proceed) waits while the mirror lags, then proceeds once it catches up', async function(){
        // First polls show the mirror behind; a later poll shows it covering block_time. The
        // barrier must keep waiting (not throw, not proceed early) until coverage, then return.
        const bt = NOW_S() + 600;
        const self = ctx({
            rowsSeq: [
                [{ ts: bt - 100 }],   // behind
                [{ ts: bt - 40 }],    // still behind
                [{ ts: bt + 1 }]      // caught up -> proceed
            ],
            timeoutMs: 10000
        });
        let threw = false;
        try { await run(self, bt); } catch(e){ threw = true; }
        assert.strictEqual(threw, false, 'must proceed (not throw) once the mirror catches up');
        assert.ok(self._doQuery.callCount >= 3, 'should have polled until coverage, got ' + self._doQuery.callCount);
    });

    it('(defer) keeps waiting when the hub DB query fails (table not ready reads as not covered)', async function(){
        // A query error must read as NOT covered: the barrier waits and then defers on timeout,
        // it never proceeds against an unread table.
        const self = ctx({ timeoutMs: 80 });
        self.hubDb.doQuery = sinon.stub().rejects(new Error('table not ready'));
        let threw = false;
        try { await run(self, NOW_S() + 3600); } catch(e){ threw = true; }
        assert.ok(threw, 'must defer (throw) on persistent table-not-ready, not proceed');
    });
});
