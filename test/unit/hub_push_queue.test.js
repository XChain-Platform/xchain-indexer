// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert       = require('assert');
const sinon        = require('sinon');
const HubPushQueue = require('../../src/hub_push_queue.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal fake indexer with stubbed indexerDb methods and
 * an optional hubClient.
 */
function makeIndexer(hubClientOpts){
    let hubClient = Object.assign({
        enabled:        true,
        pushPriceRound: sinon.stub().resolves(),
        pushOraclePrice: sinon.stub().resolves(),
        retractPriceRange: sinon.stub().resolves(),
        retractXcallRange: sinon.stub().resolves(),
        retractMatchRange: sinon.stub().resolves()
    }, hubClientOpts || {});

    let indexerDb = {
        getPendingHubPushes:    sinon.stub().resolves([]),
        recordHubPushAttempt:   sinon.stub().resolves(),
        markHubPushDelivered:   sinon.stub().resolves()
    };

    return { hubClient, indexerDb };
}

/**
 * Build a row the way the DB returns it.
 */
function makeRow(overrides){
    return Object.assign({
        id:                 1,
        push_type:          'price_round',
        payload:            JSON.stringify({ round: 5 }),
        attempts:           0,
        last_attempted_at:  null
    }, overrides || {});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HubPushQueue', function(){

    afterEach(function(){
        sinon.restore();
    });

    // -----------------------------------------------------------------------
    // constructor defaults
    // -----------------------------------------------------------------------
    describe('constructor', function(){
        it('wires indexerDb and hubClient from indexer', function(){
            let indexer = makeIndexer();
            let q = new HubPushQueue(indexer);
            assert.strictEqual(q.indexerDb, indexer.indexerDb);
            assert.strictEqual(q.hubClient, indexer.hubClient);
        });

        it('uses opts values when provided', function(){
            let indexer = makeIndexer();
            let q = new HubPushQueue(indexer, {
                intervalMs:    5000,
                baseBackoffMs: 1000,
                maxBackoffMs:  60000,
                maxAttempts:   3,
                batchSize:     10
            });
            assert.strictEqual(q.intervalMs, 5000);
            assert.strictEqual(q.baseBackoffMs, 1000);
            assert.strictEqual(q.maxBackoffMs, 60000);
            assert.strictEqual(q.maxAttempts, 3);
            assert.strictEqual(q.batchSize, 10);
        });

        it('uses env var fallbacks when neither opts nor env provided', function(){
            let indexer = makeIndexer();
            let q = new HubPushQueue(indexer, {});
            // defaults
            assert.strictEqual(q.intervalMs, 30000);
            assert.strictEqual(q.baseBackoffMs, 30000);
            assert.strictEqual(q.maxBackoffMs, 600000);
            assert.strictEqual(q.maxAttempts, 10);
            assert.strictEqual(q.batchSize, 50);
        });

        it('starts with timer=null and draining=false', function(){
            let indexer = makeIndexer();
            let q = new HubPushQueue(indexer);
            assert.strictEqual(q.timer, null);
            assert.strictEqual(q.draining, false);
        });
    });

    // -----------------------------------------------------------------------
    // start() / stop()
    // -----------------------------------------------------------------------
    describe('start() / stop()', function(){
        it('logs and does NOT set a timer when hubClient is disabled', function(){
            let indexer = makeIndexer({ enabled: false });
            let q = new HubPushQueue(indexer, { intervalMs: 10000 });
            q.start();
            assert.strictEqual(q.timer, null);
            q.stop(); // should not throw
        });

        it('logs and does NOT set a timer when hubClient is null', function(){
            let indexer = makeIndexer();
            indexer.hubClient = null;
            let q = new HubPushQueue(indexer, { intervalMs: 10000 });
            q.start();
            assert.strictEqual(q.timer, null);
        });

        it('sets a timer when hubClient is enabled', function(){
            let indexer = makeIndexer();
            let q = new HubPushQueue(indexer, { intervalMs: 60000 });
            q.start();
            assert.notStrictEqual(q.timer, null);
            q.stop();
            assert.strictEqual(q.timer, null);
        });

        it('is idempotent: calling start() twice leaves one timer', function(){
            let indexer = makeIndexer();
            let q = new HubPushQueue(indexer, { intervalMs: 60000 });
            q.start();
            let first = q.timer;
            q.start(); // second call should be a no-op
            assert.strictEqual(q.timer, first);
            q.stop();
        });

        it('stop() is safe when timer is already null', function(){
            let indexer = makeIndexer();
            let q = new HubPushQueue(indexer);
            assert.doesNotThrow(() => q.stop());
        });

        it('stop() clears the timer and sets it to null', function(){
            let indexer = makeIndexer();
            let q = new HubPushQueue(indexer, { intervalMs: 60000 });
            q.start();
            assert.notStrictEqual(q.timer, null);
            q.stop();
            assert.strictEqual(q.timer, null);
        });
    });

    // -----------------------------------------------------------------------
    // _isDue()
    // -----------------------------------------------------------------------
    describe('_isDue()', function(){
        it('returns true when last_attempted_at is null (never tried)', function(){
            let q = new HubPushQueue(makeIndexer());
            assert.strictEqual(q._isDue({ last_attempted_at: null, attempts: 0 }, Date.now()), true);
        });

        it('returns true when last_attempted_at is undefined', function(){
            let q = new HubPushQueue(makeIndexer());
            assert.strictEqual(q._isDue({ attempts: 0 }, Date.now()), true);
        });

        it('returns false when within backoff window', function(){
            let q = new HubPushQueue(makeIndexer(), { baseBackoffMs: 30000 });
            let lastAttempt = new Date(Date.now() - 1000).toISOString(); // 1s ago
            // attempts=1 → backoff = 30000 * 2^0 = 30000ms, not elapsed
            let row = { last_attempted_at: lastAttempt, attempts: 1 };
            assert.strictEqual(q._isDue(row, Date.now()), false);
        });

        it('returns true when past backoff window', function(){
            let q = new HubPushQueue(makeIndexer(), { baseBackoffMs: 1000 });
            let lastAttempt = new Date(Date.now() - 5000).toISOString(); // 5s ago
            // attempts=1 → backoff = 1000 * 2^0 = 1000ms, elapsed
            let row = { last_attempted_at: lastAttempt, attempts: 1 };
            assert.strictEqual(q._isDue(row, Date.now()), true);
        });

        it('caps backoff at maxBackoffMs', function(){
            let q = new HubPushQueue(makeIndexer(), { baseBackoffMs: 30000, maxBackoffMs: 60000 });
            // attempts=100 → uncapped backoff would be astronomical, cap=60000ms
            let lastAttempt = new Date(Date.now() - 50000).toISOString(); // 50s ago
            let row = { last_attempted_at: lastAttempt, attempts: 100 };
            // 50s < 60s cap → not due yet
            assert.strictEqual(q._isDue(row, Date.now()), false);
        });

        it('treats non-numeric attempts as 0', function(){
            let q = new HubPushQueue(makeIndexer(), { baseBackoffMs: 30000 });
            let lastAttempt = new Date(Date.now() - 1000).toISOString();
            let row = { last_attempted_at: lastAttempt, attempts: 'not-a-number' };
            // attempts=0 → backoff = 30000 * 2^max(0,-1) = 30000ms
            assert.strictEqual(q._isDue(row, Date.now()), false);
        });
    });

    // -----------------------------------------------------------------------
    // drain()
    // -----------------------------------------------------------------------
    describe('drain()', function(){
        it('returns early without calling getPendingHubPushes when draining=true', async function(){
            let indexer = makeIndexer();
            let q = new HubPushQueue(indexer);
            q.draining = true;
            await q.drain();
            assert.strictEqual(indexer.indexerDb.getPendingHubPushes.callCount, 0);
        });

        it('does nothing when there are no pending rows', async function(){
            let indexer = makeIndexer();
            indexer.indexerDb.getPendingHubPushes.resolves([]);
            let q = new HubPushQueue(indexer);
            await q.drain();
            assert.strictEqual(indexer.indexerDb.markHubPushDelivered.callCount, 0);
        });

        it('does nothing when rows is null', async function(){
            let indexer = makeIndexer();
            indexer.indexerDb.getPendingHubPushes.resolves(null);
            let q = new HubPushQueue(indexer);
            await q.drain();
            assert.strictEqual(indexer.indexerDb.markHubPushDelivered.callCount, 0);
        });

        it('resets draining=false even when _attempt throws', async function(){
            let indexer = makeIndexer();
            let row = makeRow();
            indexer.indexerDb.getPendingHubPushes.resolves([row]);
            let q = new HubPushQueue(indexer, { baseBackoffMs: 0 });
            sinon.stub(q, '_attempt').rejects(new Error('unexpected'));
            await assert.rejects(() => q.drain());
            // draining must be false after the finally block
            assert.strictEqual(q.draining, false);
        });

        it('skips rows that are not yet due', async function(){
            let indexer = makeIndexer();
            let row = makeRow({
                last_attempted_at: new Date(Date.now() - 100).toISOString(),
                attempts: 5
                // baseBackoffMs default 30000 → very long wait → not due
            });
            indexer.indexerDb.getPendingHubPushes.resolves([row]);
            let q = new HubPushQueue(indexer);
            let attemptStub = sinon.stub(q, '_attempt').resolves();
            await q.drain();
            assert.strictEqual(attemptStub.callCount, 0);
        });

        it('calls _attempt for each due row', async function(){
            let indexer = makeIndexer();
            let rows = [
                makeRow({ id: 1, last_attempted_at: null }),
                makeRow({ id: 2, last_attempted_at: null })
            ];
            indexer.indexerDb.getPendingHubPushes.resolves(rows);
            let q = new HubPushQueue(indexer);
            let attemptStub = sinon.stub(q, '_attempt').resolves();
            await q.drain();
            assert.strictEqual(attemptStub.callCount, 2);
            assert.strictEqual(attemptStub.firstCall.args[0], rows[0]);
            assert.strictEqual(attemptStub.secondCall.args[0], rows[1]);
        });

        it('passes batchSize to getPendingHubPushes', async function(){
            let indexer = makeIndexer();
            let q = new HubPushQueue(indexer, { batchSize: 7 });
            await q.drain();
            assert.strictEqual(indexer.indexerDb.getPendingHubPushes.calledWith(7), true);
        });

        it('sweeps aged failed rows on the drain tick even when nothing is pending', async function(){
            let indexer = makeIndexer();
            indexer.indexerDb.pruneFailedHubPushes = sinon.stub().resolves(3);
            indexer.indexerDb.getPendingHubPushes.resolves([]);
            let q = new HubPushQueue(indexer, { failedRetentionSec: 1234 });
            await q.drain();
            assert.strictEqual(indexer.indexerDb.pruneFailedHubPushes.calledWith(1234), true);
        });
    });

    // -----------------------------------------------------------------------
    // _pruneFailed()  (item 3462: terminal rows must not accumulate forever)
    // -----------------------------------------------------------------------
    describe('_pruneFailed()', function(){
        it('throttles to one sweep per pruneIntervalMs', async function(){
            let indexer = makeIndexer();
            indexer.indexerDb.pruneFailedHubPushes = sinon.stub().resolves(0);
            let q = new HubPushQueue(indexer, { pruneIntervalMs: 3600000 });
            await q._pruneFailed();
            await q._pruneFailed();
            await q._pruneFailed();
            assert.strictEqual(indexer.indexerDb.pruneFailedHubPushes.callCount, 1);
        });

        it('sweeps again once the interval has elapsed', async function(){
            let indexer = makeIndexer();
            indexer.indexerDb.pruneFailedHubPushes = sinon.stub().resolves(0);
            let q = new HubPushQueue(indexer, { pruneIntervalMs: 1000 });
            await q._pruneFailed();
            q._lastPruneMs = Date.now() - 2000;
            await q._pruneFailed();
            assert.strictEqual(indexer.indexerDb.pruneFailedHubPushes.callCount, 2);
        });

        it('never prunes when retention is 0 (retain-forever opt-out)', async function(){
            let indexer = makeIndexer();
            indexer.indexerDb.pruneFailedHubPushes = sinon.stub().resolves(0);
            let q = new HubPushQueue(indexer, { failedRetentionSec: 0 });
            await q._pruneFailed();
            assert.strictEqual(indexer.indexerDb.pruneFailedHubPushes.callCount, 0);
        });

        it('swallows a prune error so the drain still delivers', async function(){
            let indexer = makeIndexer();
            indexer.indexerDb.pruneFailedHubPushes = sinon.stub().rejects(new Error('db down'));
            indexer.indexerDb.getPendingHubPushes.resolves([makeRow({ last_attempted_at: null })]);
            let q = new HubPushQueue(indexer);
            let attemptStub = sinon.stub(q, '_attempt').resolves();
            await q.drain();
            assert.strictEqual(attemptStub.callCount, 1);
        });

        it('is inert against a db double without the prune method', async function(){
            let indexer = makeIndexer();
            let q = new HubPushQueue(indexer);
            assert.strictEqual(await q._pruneFailed(), 0);
        });
    });

    // -----------------------------------------------------------------------
    // _attempt()
    // -----------------------------------------------------------------------
    describe('_attempt()', function(){
        it('marks row failed immediately when payload is not parseable JSON', async function(){
            let indexer = makeIndexer();
            let q = new HubPushQueue(indexer);
            let row = makeRow({ id: 9, payload: '{{invalid json' });
            await q._attempt(row);
            assert.strictEqual(indexer.indexerDb.recordHubPushAttempt.calledOnce, true);
            let [id, msg] = indexer.indexerDb.recordHubPushAttempt.firstCall.args;
            assert.strictEqual(id, 9);
            assert.match(msg, /unparseable payload/);
        });

        it('accepts payload that is already an object (not a string)', async function(){
            let indexer = makeIndexer();
            let q = new HubPushQueue(indexer);
            let row = makeRow({ push_type: 'price_round', payload: { round: 1 } });
            await q._attempt(row);
            assert.strictEqual(indexer.hubClient.pushPriceRound.calledOnce, true);
            assert.strictEqual(indexer.indexerDb.markHubPushDelivered.calledOnce, true);
        });

        it('calls pushPriceRound for price_round rows and marks delivered', async function(){
            let indexer = makeIndexer();
            let q = new HubPushQueue(indexer);
            let payload = { round: 5, coin: 'BTC' };
            let row = makeRow({ id: 1, push_type: 'price_round', payload: JSON.stringify(payload) });
            await q._attempt(row);
            assert.strictEqual(indexer.hubClient.pushPriceRound.calledOnce, true);
            assert.deepStrictEqual(indexer.hubClient.pushPriceRound.firstCall.args[0], payload);
            assert.strictEqual(indexer.indexerDb.markHubPushDelivered.calledWith(1), true);
        });

        it('calls pushOraclePrice for oracle_price rows and marks delivered', async function(){
            let indexer = makeIndexer();
            let q = new HubPushQueue(indexer);
            let payload = { tick: 'AAA', price: '1.00' };
            let row = makeRow({ id: 2, push_type: 'oracle_price', payload: JSON.stringify(payload) });
            await q._attempt(row);
            assert.strictEqual(indexer.hubClient.pushOraclePrice.calledOnce, true);
            assert.deepStrictEqual(indexer.hubClient.pushOraclePrice.firstCall.args[0], payload);
            assert.strictEqual(indexer.indexerDb.markHubPushDelivered.calledWith(2), true);
        });

        it('calls retractPriceRange for price_retraction rows and marks delivered (open-ended when no ceiling)', async function(){
            let indexer = makeIndexer();
            let q = new HubPushQueue(indexer);
            let payload = { coin: 'BTC', action_index: 4200 };
            let row = makeRow({ id: 7, push_type: 'price_retraction', payload: JSON.stringify(payload) });
            await q._attempt(row);
            assert.strictEqual(indexer.hubClient.retractPriceRange.calledOnce, true);
            // Back-compat: a payload without last_action_index/retraction_generation passes undefined
            // for both the ceiling (item 5296) and the generation fence (item 5308), which the
            // hub_client treats as open-ended + no fence.
            assert.deepStrictEqual(indexer.hubClient.retractPriceRange.firstCall.args, ['BTC', 4200, undefined, undefined]);
            assert.strictEqual(indexer.indexerDb.markHubPushDelivered.calledWith(7), true);
        });

        it('passes last_action_index + retraction_generation from the payload (items 5296/5308)', async function(){
            let indexer = makeIndexer();
            let q = new HubPushQueue(indexer);
            let payload = { coin: 'BTC', action_index: 4200, last_action_index: 4250, retraction_generation: 5 };
            let row = makeRow({ id: 8, push_type: 'price_retraction', payload: JSON.stringify(payload) });
            await q._attempt(row);
            assert.deepStrictEqual(indexer.hubClient.retractPriceRange.firstCall.args, ['BTC', 4200, 4250, 5]);
            assert.strictEqual(indexer.indexerDb.markHubPushDelivered.calledWith(8), true);
        });

        it('calls retractXcallRange / retractMatchRange with the ceiling + generation fence', async function(){
            let indexer = makeIndexer();
            let q = new HubPushQueue(indexer);
            await q._attempt(makeRow({ id: 9,  push_type: 'xcall_retraction', payload: JSON.stringify({ coin: 'BTC', action_index: 10, last_action_index: 20, retraction_generation: 3 }) }));
            await q._attempt(makeRow({ id: 10, push_type: 'match_retraction', payload: JSON.stringify({ coin: 'BTC', action_index: 30, last_action_index: 40, retraction_generation: 4 }) }));
            assert.deepStrictEqual(indexer.hubClient.retractXcallRange.firstCall.args, ['BTC', 10, 20, 3]);
            assert.deepStrictEqual(indexer.hubClient.retractMatchRange.firstCall.args, ['BTC', 30, 40, 4]);
        });

        it('drain() is a no-op while paused, and resumes after resume()', async function(){
            let indexer = makeIndexer();
            let q = new HubPushQueue(indexer);
            q.pause();
            await q.drain();
            assert.strictEqual(indexer.indexerDb.getPendingHubPushes.called, false, 'paused drain must not fetch');
            q.resume();
            await q.drain();
            assert.strictEqual(indexer.indexerDb.getPendingHubPushes.called, true, 'resumed drain fetches');
        });

        it('marks row failed for unknown push_type', async function(){
            let indexer = makeIndexer();
            let q = new HubPushQueue(indexer);
            let row = makeRow({ id: 3, push_type: 'mystery_type', payload: JSON.stringify({}) });
            await q._attempt(row);
            assert.strictEqual(indexer.indexerDb.recordHubPushAttempt.calledOnce, true);
            let [id, msg] = indexer.indexerDb.recordHubPushAttempt.firstCall.args;
            assert.strictEqual(id, 3);
            assert.match(msg, /unknown push_type/);
        });

        it('records failed attempt when pushPriceRound rejects', async function(){
            let indexer = makeIndexer();
            indexer.hubClient.pushPriceRound = sinon.stub().rejects(new Error('hub unavailable'));
            let q = new HubPushQueue(indexer, { maxAttempts: 5 });
            let row = makeRow({ id: 4, push_type: 'price_round', attempts: 2 });
            await q._attempt(row);
            assert.strictEqual(indexer.indexerDb.recordHubPushAttempt.calledOnce, true);
            let [id, msg, max] = indexer.indexerDb.recordHubPushAttempt.firstCall.args;
            assert.strictEqual(id, 4);
            assert.match(msg, /hub unavailable/);
            assert.strictEqual(max, 5);  // maxAttempts passed through
        });

        it('records failed attempt when pushOraclePrice rejects', async function(){
            let indexer = makeIndexer();
            indexer.hubClient.pushOraclePrice = sinon.stub().rejects(new Error('oracle error'));
            let q = new HubPushQueue(indexer, { maxAttempts: 3 });
            let row = makeRow({ id: 5, push_type: 'oracle_price', attempts: 0 });
            await q._attempt(row);
            assert.strictEqual(indexer.indexerDb.recordHubPushAttempt.calledOnce, true);
            let [id, msg, max] = indexer.indexerDb.recordHubPushAttempt.firstCall.args;
            assert.strictEqual(id, 5);
            assert.match(msg, /oracle error/);
            // Was maxAttempts (3). An oracle_price is never re-derivable (actions/price.js),
            // so item 4280 moved it to the retraction's unbounded cap; see the dedicated
            // never-retires test below.
            assert.strictEqual(max, Number.MAX_SAFE_INTEGER);
        });

        it('truncates very long error messages to 480 chars', async function(){
            let indexer = makeIndexer();
            let longMsg = 'x'.repeat(1000);
            indexer.hubClient.pushPriceRound = sinon.stub().rejects(new Error(longMsg));
            let q = new HubPushQueue(indexer);
            let row = makeRow({ id: 6, push_type: 'price_round' });
            await q._attempt(row);
            let [, msg] = indexer.indexerDb.recordHubPushAttempt.firstCall.args;
            assert.strictEqual(msg.length, 480);
        });

        it('does NOT call markHubPushDelivered on push failure', async function(){
            let indexer = makeIndexer();
            indexer.hubClient.pushPriceRound = sinon.stub().rejects(new Error('fail'));
            let q = new HubPushQueue(indexer);
            let row = makeRow({ push_type: 'price_round' });
            await q._attempt(row);
            assert.strictEqual(indexer.indexerDb.markHubPushDelivered.callCount, 0);
        });

        it('does NOT call pushPriceRound or pushOraclePrice on unknown type', async function(){
            let indexer = makeIndexer();
            let q = new HubPushQueue(indexer);
            let row = makeRow({ push_type: 'unknown' });
            await q._attempt(row);
            assert.strictEqual(indexer.hubClient.pushPriceRound.callCount, 0);
            assert.strictEqual(indexer.hubClient.pushOraclePrice.callCount, 0);
        });

        it('handles attempts=0 correctly (first attempt is attempt #1)', async function(){
            let indexer = makeIndexer();
            indexer.hubClient.pushPriceRound = sinon.stub().rejects(new Error('fail'));
            let q = new HubPushQueue(indexer, { maxAttempts: 10 });
            // capture console.warn to verify the attempt number logged
            let warnMsg = '';
            let origWarn = console.warn;
            console.warn = (...args) => { warnMsg = args.join(' '); };
            let row = makeRow({ id: 7, push_type: 'price_round', attempts: 0 });
            await q._attempt(row);
            console.warn = origWarn;
            // attempt 0+1=1
            assert.ok(warnMsg.includes('attempt 1/10'), 'expected "attempt 1/10" in: ' + warnMsg);
        });

        // ─── Retractions are exempt from the attempt cap (HUB-RETRACT-5) ─────
        // A reorg retraction is the ONLY remaining record that the hub must prune an orphaned
        // range; retiring it to 'failed' after maxAttempts (a hub outage overlapping a reorg)
        // permanently strands stale prices / 'finalized' XCALL+DEX rows on the hub. Retractions
        // are idempotent + generation-fenced, so they must retry indefinitely, never retire.
        for(const rt of ['price_retraction', 'xcall_retraction', 'match_retraction']){
            it('does NOT retire a ' + rt + ' after maxAttempts failures (retries forever)', async function(){
                let indexer = makeIndexer();
                indexer.hubClient.retractPriceRange = sinon.stub().rejects(new Error('hub down'));
                indexer.hubClient.retractXcallRange = sinon.stub().rejects(new Error('hub down'));
                indexer.hubClient.retractMatchRange = sinon.stub().rejects(new Error('hub down'));
                let q = new HubPushQueue(indexer, { maxAttempts: 3 });
                // A row that has already burned through maxAttempts: a forward push would be retired.
                let row = makeRow({ id: 9, push_type: rt, attempts: 3,
                    payload: JSON.stringify({ coin: 'BTC', action_index: 50, last_action_index: 60, retraction_generation: 4 }) });
                await q._attempt(row);
                assert.ok(indexer.indexerDb.recordHubPushAttempt.calledOnce, 'recordHubPushAttempt should be called');
                let cap = indexer.indexerDb.recordHubPushAttempt.firstCall.args[2];
                assert.strictEqual(cap, Number.MAX_SAFE_INTEGER,
                    'a retraction must be recorded with an unbounded cap so it never flips to failed');
            });
        }

        it('DOES retire a best-effort forward push at the attempt cap (unchanged)', async function(){
            let indexer = makeIndexer();
            indexer.hubClient.pushPriceRound = sinon.stub().rejects(new Error('fail'));
            let q = new HubPushQueue(indexer, { maxAttempts: 3 });
            let row = makeRow({ id: 11, push_type: 'price_round', attempts: 2 });
            await q._attempt(row);
            let cap = indexer.indexerDb.recordHubPushAttempt.firstCall.args[2];
            assert.strictEqual(cap, 3, 'a forward push keeps the finite maxAttempts cap');
        });

        // ─── oracle_price joins the unbounded set (item 4280) ─────
        // actions/price.js: a PRICE v1 oracle price is never re-emitted by a later block, so
        // "a lost oracle_price is never re-derivable" and the outbox exists to guarantee it is
        // not lost. The ~10-attempt cap retired it to 'failed' after ~30 minutes of hub outage
        // and _pruneFailed deleted it, defeating that guarantee.
        it('does NOT retire an oracle_price after maxAttempts failures (never re-derivable)', async function(){
            let indexer = makeIndexer();
            indexer.hubClient.pushOraclePrice = sinon.stub().rejects(new Error('hub down'));
            let q = new HubPushQueue(indexer, { maxAttempts: 3 });
            let row = makeRow({ id: 12, push_type: 'oracle_price', attempts: 3 });
            await q._attempt(row);
            let cap = indexer.indexerDb.recordHubPushAttempt.firstCall.args[2];
            assert.strictEqual(cap, Number.MAX_SAFE_INTEGER,
                'an oracle_price must be recorded with an unbounded cap so it never flips to failed');
            assert.strictEqual(indexer.indexerDb.markHubPushDelivered.callCount, 0,
                'a failed oracle_price row must stay queued, never be dropped');
        });
    });

    // ─── HUB-RETRACT-3: pause() waits for an in-flight drain ─────
    describe('pause() awaits in-flight drain', function(){
        it('does not resolve until a drain that is mid-attempt finishes', async function(){
            let indexer = makeIndexer();
            let releaseAttempt;
            // The in-flight _attempt hangs on this promise until we release it.
            indexer.hubClient.pushPriceRound = sinon.stub().callsFake(() => new Promise(r => { releaseAttempt = r; }));
            indexer.indexerDb.getPendingHubPushes = sinon.stub().resolves([
                makeRow({ id: 1, push_type: 'price_round', attempts: 0, last_attempted_at: null })
            ]);
            let q = new HubPushQueue(indexer);
            let drainP = q.drain();                              // enters drain, stalls in _attempt
            await new Promise(r => setImmediate(r));             // let it reach the stalled attempt
            let paused = false;
            let pauseP = q.pause().then(() => { paused = true; });
            await new Promise(r => setImmediate(r));
            assert.strictEqual(paused, false, 'pause() must not resolve while a drain is in flight');
            releaseAttempt();                                    // let the attempt + drain complete
            await pauseP;
            assert.strictEqual(paused, true, 'pause() resolves once the in-flight drain finishes');
            assert.strictEqual(q.draining, false, 'draining flag cleared after the drain completes');
            await drainP;
        });

        it('resolves immediately when no drain is in flight', async function(){
            let q = new HubPushQueue(makeIndexer());
            await q.pause();   // must not hang
            assert.strictEqual(q.paused, true);
        });
    });
});
