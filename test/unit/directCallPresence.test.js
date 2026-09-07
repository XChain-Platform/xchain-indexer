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
// The barrier proceeds when the mirror covers block_time (MAX(effective_time) over
// finalized rows >= block_time, or the table is empty), OR when the HUB's own clock
// (UNIX_TIMESTAMP() on the same query) has passed block_time + the frozen call grace.
// When neither holds it DEFERS: it polls with a bounded sleep loop and throws on
// timeout so the caller retries the block, never proceeding with a partial set. The
// old UNGRACED wall-clock proceed (node's Date.now >= block_time) and the
// proceed-on-timeout behavior stay gone; these tests pin all of it.
//
// The hub-clock escape is the fix: without it the barrier keys liveness on CALL
// TRAFFIC, so once XCALL traffic went idle and chain time walked past the newest
// finalized effective_time, no condition could ever be met again and a single-host
// indexer deferred every block forever.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert         = require('assert');
const sinon          = require('sinon');
const XChainIndexer  = require('../../src/XChainIndexer.js');
// Assert against the frozen protocol constant rather than restating 120, so a change
// to the grace cannot pass these tests against a stale number.
const { HUB_SYNC_WATERMARK_GRACE_S } = require('../../src/hub_db_sync.js');
// The barrier's injected util.sleep is a spy over the shared fixed-delay helper,
// so the poll loop under test uses a real (spied) timer, not a raw setTimeout.
const { sleep }      = require('../helpers/wait.js');

const NOW_S = () => Math.floor(Date.now() / 1000);
const GRACE = HUB_SYNC_WATERMARK_GRACE_S.call;

// A hub-DB row as the barrier's query returns it: the finalized watermark plus the hub's
// own clock. `hubNow` defaults to this host's clock, which is what a single-host stack
// (hub and indexer on one box) actually reports; tests that care about clock PROVENANCE
// pin it explicitly.
function row(ts, hubNow){
    return { ts: ts, hub_now: (hubNow !== undefined ? hubNow : NOW_S()) };
}

function ctx(opts){
    opts = opts || {};
    let call = 0;
    const doQuery = sinon.stub().callsFake(async () => {
        if(opts.rowsSeq){
            const r = opts.rowsSeq[Math.min(call, opts.rowsSeq.length - 1)];
            call++;
            return typeof r === 'function' ? r() : r;
        }
        return opts.rows || [row(null)];
    });
    const sleepSpy = sinon.spy((ms) => sleep(ms));
    return {
        hubDb: opts.noHubDb ? null : { doQuery },
        callPresenceTimeoutMs: opts.timeoutMs != null ? opts.timeoutMs : 10000,
        // Left undefined by default so the barrier's fallback to the frozen constant is
        // what most tests exercise; start() sets it on a real indexer.
        directCallGraceS: opts.graceS,
        util: {
            sleep: sleepSpy,
            throwError: (msg) => { throw new Error(msg); }
        },
        _doQuery: doQuery,
        _sleep: sleepSpy
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
        const self = ctx({ rows: [row(bt + 5)] });
        await run(self, bt);
        assert.strictEqual(self._doQuery.calledOnce, true);
        assert.strictEqual(self._sleep.called, false, 'fast path must add no latency (no sleep)');
    });

    it('(fast path) proceeds at once when the hub holds no finalized calls (nothing to wait on)', async function(){
        // Empty table: nothing can be effective at/before block_time, so proceed immediately.
        const self = ctx({ rows: [row(null)] });
        await run(self, NOW_S());
        assert.strictEqual(self._doQuery.calledOnce, true);
        assert.strictEqual(self._sleep.called, false, 'fast path must not sleep');
    });

    it('(fast path) does NOT proceed on an UNGRACED wall-clock gate when the mirror is behind', async function(){
        // A block_time barely in the past: the ORIGINAL code returned immediately via the
        // node's Date.now() with no margin at all. That gate stays removed. The hub-clock
        // escape does not cover this block either (the hub clock has not reached
        // block_time + grace), so a behind mirror must still defer.
        const bt = NOW_S() - 5;
        const self = ctx({ rows: [row(bt - 10, bt + GRACE - 1)], timeoutMs: 80 });
        let threw = false;
        try { await run(self, bt); } catch(e){ threw = true; }
        assert.ok(threw, 'must defer (throw) for a behind mirror inside the grace window');
        assert.ok(self._doQuery.called, 'must query the mirror, not short-circuit on wall-clock');
    });

    it('(defer) throws on timeout when the mirror never catches up (no partial-set proceed)', async function(){
        // Mirror always reports a watermark BELOW block_time and the hub clock is nowhere
        // near the escape: it is genuinely behind. The barrier must NOT proceed; it polls
        // within the bound and then throws so the caller defers and retries the block.
        const bt = NOW_S() + 3600;
        const self = ctx({ rows: [row(bt - 50, bt - 40)], timeoutMs: 80 });
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
                [row(bt - 100, bt - 100)],   // behind
                [row(bt - 40,  bt - 40)],    // still behind
                [row(bt + 1,   bt - 30)]     // caught up -> proceed
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

    // ── Hub-clock escape hatch ────────────────────────────────────────────────────
    //
    // Liveness must not be keyed on cross-chain call TRAFFIC. Once the newest finalized
    // cross_chain_call is in the chain's past and no new call is ever finalized, the
    // coverage condition can never be met again, and before this hatch every subsequent
    // block deferred forever on an otherwise healthy chain.

    describe('hub-clock escape hatch', function(){

        it('proceeds once the hub clock passes block_time + the call grace', async function(){
            // The wedge shape: newest finalized call a day old, block an hour old, no new
            // XCALL traffic. Coverage can never be satisfied; the escape must open.
            const now = NOW_S();
            const bt  = now - 3600;
            const self = ctx({ rows: [row(now - 86400, now)], timeoutMs: 80 });
            await run(self, bt);
            assert.strictEqual(self._doQuery.calledOnce, true, 'escape must open on the first poll');
            assert.strictEqual(self._sleep.called, false, 'escape must not enter the poll loop');
        });

        it('an idle-traffic chain stops deferring: every retry would have deferred before', async function(){
            // Drive the caller's defer-and-retry loop the way the block loop does. Before the
            // hatch every attempt threw; now the very first one returns.
            const now = NOW_S();
            const bt  = now - 7200;
            const self = ctx({ rows: [row(now - 86400, now)], timeoutMs: 80 });
            let deferred = 0;
            for(let i = 0; i < 3; i++){
                try { await run(self, bt); } catch(e){ deferred++; }
            }
            assert.strictEqual(deferred, 0, 'a healthy idle-traffic chain must not defer at all');
        });

        it('opens exactly AT block_time + grace, not before', async function(){
            // Boundary pin, both sides, on the frozen constant.
            const bt = NOW_S();
            const early = ctx({ rows: [row(bt - 500, bt + GRACE - 1)], timeoutMs: 60 });
            let threw = false;
            try { await run(early, bt); } catch(e){ threw = true; }
            assert.ok(threw, 'must still defer one second before the escape instant');

            const at = ctx({ rows: [row(bt - 500, bt + GRACE)], timeoutMs: 60 });
            await run(at, bt);                        // resolves: exactly at the instant
            assert.strictEqual(at._doQuery.calledOnce, true);
        });

        it('keys on the HUB clock, never this node\'s', async function(){
            // A hub whose clock is behind must hold the barrier shut even though the local
            // clock is long past the escape instant. The mirrored path keys on the hub's
            // watermark heartbeat, so the direct path must key on the same clock or two
            // operators of the same chain inject at different blocks.
            const bt = NOW_S() - 100000;              // local clock is WAY past bt + grace
            const self = ctx({ rows: [row(bt - 500, bt - 10)], timeoutMs: 60 });
            let threw = false;
            try { await run(self, bt); } catch(e){ threw = true; }
            assert.ok(threw, 'a lagging hub clock must keep the escape shut regardless of local time');
        });

        it('reads the hub clock from the SAME query as the watermark', async function(){
            // One reading, one connection, one instant: a second round trip would let skew
            // between the two readings decide a consensus barrier.
            const self = ctx({ rows: [row(null)] });
            await run(self, NOW_S());
            const sql = self._doQuery.firstCall.args[0];
            assert.ok(/MAX\(effective_time\)/.test(sql), 'query must still read the watermark');
            assert.ok(/UNIX_TIMESTAMP\(\)/.test(sql),    'query must read the hub clock alongside it');
            assert.strictEqual(self._doQuery.callCount, 1, 'must not issue a second clock query');
        });

        it('falls back to the frozen call grace when directCallGraceS was never resolved', async function(){
            // A hand-built caller (or any path that skipped start()) must get the protocol
            // value, not NaN: NaN makes every escape comparison false and restores the wedge.
            const bt = NOW_S();
            const self = ctx({ rows: [row(bt - 500, bt + GRACE)], timeoutMs: 60 });
            assert.strictEqual(self.directCallGraceS, undefined);
            await run(self, bt);
            assert.strictEqual(self._doQuery.calledOnce, true);
        });

        it('honors a resolved directCallGraceS (the regtest override path)', async function(){
            // start() resolves the grace through hub_db_sync's resolveWatermarkGrace, which
            // honors HUB_SYNC_CALL_GRACE_S on regtest only. The barrier must use that value.
            const bt = NOW_S();
            const self = ctx({ rows: [row(bt - 500, bt + 5)], graceS: 5, timeoutMs: 60 });
            await run(self, bt);                      // opens at the overridden 5s, not at GRACE
            assert.strictEqual(self._doQuery.calledOnce, true);

            const shut = ctx({ rows: [row(bt - 500, bt + 5)], graceS: 3600, timeoutMs: 60 });
            let threw = false;
            try { await run(shut, bt); } catch(e){ threw = true; }
            assert.ok(threw, 'a larger override must hold the escape shut');
        });

        it('an absent hub clock reads as not covered (never proceeds on a bad reading)', async function(){
            // An old hub DB, a driver that drops the column, a NULL: none of them may be read
            // as "the clock is past the escape". NULL in particular must not coerce to 0 and
            // be treated as a real (finite) reading; the diagnostic must say null, not 0.
            const bt = NOW_S() - 100000;              // local clock is far past bt + grace
            for(const bad of [{ ts: bt - 500, hub_now: null }, { ts: bt - 500 }]){
                const self = ctx({ rows: [bad], timeoutMs: 60 });
                let msg = null;
                try { await run(self, bt); } catch(e){ msg = e.message; }
                assert.ok(msg, 'must defer on an unreadable hub clock');
                assert.ok(msg.indexOf('hub clock at null') !== -1,
                    'an absent reading must stay null, never coerce to 0: ' + msg);
            }
        });

        it('names the escape instant in the timeout diagnostic', async function(){
            // The operator has to be able to tell a barrier that is merely early from one
            // that is wedged, which means seeing when it CAN open.
            const bt = NOW_S();
            const self = ctx({ rows: [row(bt - 500, bt - 10)], timeoutMs: 60 });
            let msg = '';
            try { await run(self, bt); } catch(e){ msg = e.message; }
            assert.ok(msg.indexOf('hub clock at ' + (bt - 10)) !== -1, 'diagnostic: ' + msg);
            assert.ok(msg.indexOf('escape at ' + (bt + GRACE)) !== -1, 'diagnostic: ' + msg);
        });
    });

    describe('_directCallBarrierClearsAt (health verdict)', function(){
        const clearsAt = (self, bt) =>
            XChainIndexer.prototype._directCallBarrierClearsAt.call(self, bt);

        it('reports the escape instant so /status can call the stall self-clearing', function(){
            const bt = NOW_S() + 3600;                 // a future-stamped block
            const self = ctx({ graceS: 120 });
            assert.strictEqual(clearsAt(self, bt), (bt + 120) * 1000);
        });

        it('falls back to the frozen grace, and is null without a hub DB or a usable block_time', function(){
            const bt = NOW_S();
            assert.strictEqual(clearsAt(ctx({}), bt), (bt + GRACE) * 1000);
            assert.strictEqual(clearsAt(ctx({ noHubDb: true }), bt), null);
            assert.strictEqual(clearsAt(ctx({}), NaN), null);
        });
    });
});
