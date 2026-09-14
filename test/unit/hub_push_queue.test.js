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
const HubPushQueue = require('../../src/hub/hub_push_queue.js');
const { makeIndexer, makeRow } = require('./hub_push_queue.test/helpers/fixtures.js');


// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------



// -----------------------------------------------------------------------
// constructor defaults
// -----------------------------------------------------------------------
function registerHubPushQueueGroup1() { describe('constructor', function(){
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
}); }

// -----------------------------------------------------------------------
// start() / stop()
// -----------------------------------------------------------------------
function registerHubPushQueueGroup2() { describe('start() / stop()', function(){
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
}); }

// -----------------------------------------------------------------------
// isDue()
// -----------------------------------------------------------------------
function registerHubPushQueueGroup3() { describe('_isDue()', function(){
        it('returns true when last_attempted_at is null (never tried)', function(){
            let q = new HubPushQueue(makeIndexer());
            assert.strictEqual(q.isDue({ last_attempted_at: null, attempts: 0 }, Date.now()), true);
        });

        it('returns true when last_attempted_at is undefined', function(){
            let q = new HubPushQueue(makeIndexer());
            assert.strictEqual(q.isDue({ attempts: 0 }, Date.now()), true);
        });

        it('returns false when within backoff window', function(){
            let q = new HubPushQueue(makeIndexer(), { baseBackoffMs: 30000 });
            let lastAttempt = new Date(Date.now() - 1000).toISOString(); // 1s ago
            // attempts=1 → backoff = 30000 * 2^0 = 30000ms, not elapsed
            let row = { last_attempted_at: lastAttempt, attempts: 1 };
            assert.strictEqual(q.isDue(row, Date.now()), false);
        });

        it('returns true when past backoff window', function(){
            let q = new HubPushQueue(makeIndexer(), { baseBackoffMs: 1000 });
            let lastAttempt = new Date(Date.now() - 5000).toISOString(); // 5s ago
            // attempts=1 → backoff = 1000 * 2^0 = 1000ms, elapsed
            let row = { last_attempted_at: lastAttempt, attempts: 1 };
            assert.strictEqual(q.isDue(row, Date.now()), true);
        });

        it('caps backoff at maxBackoffMs', function(){
            let q = new HubPushQueue(makeIndexer(), { baseBackoffMs: 30000, maxBackoffMs: 60000 });
            // attempts=100 → uncapped backoff would be astronomical, cap=60000ms
            let lastAttempt = new Date(Date.now() - 50000).toISOString(); // 50s ago
            let row = { last_attempted_at: lastAttempt, attempts: 100 };
            // 50s < 60s cap → not due yet
            assert.strictEqual(q.isDue(row, Date.now()), false);
        });

        it('treats non-numeric attempts as 0', function(){
            let q = new HubPushQueue(makeIndexer(), { baseBackoffMs: 30000 });
            let lastAttempt = new Date(Date.now() - 1000).toISOString();
            let row = { last_attempted_at: lastAttempt, attempts: 'not-a-number' };
            // attempts=0 → backoff = 30000 * 2^max(0,-1) = 30000ms
            assert.strictEqual(q.isDue(row, Date.now()), false);
        });
}); }

// -----------------------------------------------------------------------
// drain()
// -----------------------------------------------------------------------
function registerHubPushQueueGroup4() { describe('drain()', function(){
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
            sinon.stub(q, 'attempt').rejects(new Error('unexpected'));
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
            let attemptStub = sinon.stub(q, 'attempt').resolves();
            await q.drain();
            assert.strictEqual(attemptStub.callCount, 0);
        });
}); }

function registerHubPushQueueGroup5() { describe('drain()', function(){
        it('calls _attempt for each due row', async function(){
            let indexer = makeIndexer();
            let rows = [
                makeRow({ id: 1, last_attempted_at: null }),
                makeRow({ id: 2, last_attempted_at: null })
            ];
            indexer.indexerDb.getPendingHubPushes.resolves(rows);
            let q = new HubPushQueue(indexer);
            let attemptStub = sinon.stub(q, 'attempt').resolves();
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
}); }

// -----------------------------------------------------------------------
// pruneFailed()  (item 3462: terminal rows must not accumulate forever)
// -----------------------------------------------------------------------
function registerHubPushQueueGroup6() { describe('_pruneFailed()', function(){
        it('throttles to one sweep per pruneIntervalMs', async function(){
            let indexer = makeIndexer();
            indexer.indexerDb.pruneFailedHubPushes = sinon.stub().resolves(0);
            let q = new HubPushQueue(indexer, { pruneIntervalMs: 3600000 });
            await q.pruneFailed();
            await q.pruneFailed();
            await q.pruneFailed();
            assert.strictEqual(indexer.indexerDb.pruneFailedHubPushes.callCount, 1);
        });

        it('sweeps again once the interval has elapsed', async function(){
            let indexer = makeIndexer();
            indexer.indexerDb.pruneFailedHubPushes = sinon.stub().resolves(0);
            let q = new HubPushQueue(indexer, { pruneIntervalMs: 1000 });
            await q.pruneFailed();
            q._lastPruneMs = Date.now() - 2000;
            await q.pruneFailed();
            assert.strictEqual(indexer.indexerDb.pruneFailedHubPushes.callCount, 2);
        });

        it('never prunes when retention is 0 (retain-forever opt-out)', async function(){
            let indexer = makeIndexer();
            indexer.indexerDb.pruneFailedHubPushes = sinon.stub().resolves(0);
            let q = new HubPushQueue(indexer, { failedRetentionSec: 0 });
            await q.pruneFailed();
            assert.strictEqual(indexer.indexerDb.pruneFailedHubPushes.callCount, 0);
        });

        it('swallows a prune error so the drain still delivers', async function(){
            let indexer = makeIndexer();
            indexer.indexerDb.pruneFailedHubPushes = sinon.stub().rejects(new Error('db down'));
            indexer.indexerDb.getPendingHubPushes.resolves([makeRow({ last_attempted_at: null })]);
            let q = new HubPushQueue(indexer);
            let attemptStub = sinon.stub(q, 'attempt').resolves();
            await q.drain();
            assert.strictEqual(attemptStub.callCount, 1);
        });

        it('is inert against a db double without the prune method', async function(){
            let indexer = makeIndexer();
            let q = new HubPushQueue(indexer);
            assert.strictEqual(await q.pruneFailed(), 0);
        });
}); }

describe('HubPushQueue', function(){

    afterEach(function(){
        sinon.restore();
    });

    registerHubPushQueueGroup1();
    registerHubPushQueueGroup2();
    registerHubPushQueueGroup3();
    registerHubPushQueueGroup4();
    registerHubPushQueueGroup5();
    registerHubPushQueueGroup6();
});
