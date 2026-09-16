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
const HubPushQueue = require('../../../../src/hub/hub_push_queue.js');
const { makeIndexer, makeRow } = require('./helpers/fixtures.js');


// -----------------------------------------------------------------------
// attempt()
// -----------------------------------------------------------------------
function registerHubPushQueueGroup7() { describe('_attempt()', function(){
        it('marks row failed immediately when payload is not parseable JSON', async function(){
            let indexer = makeIndexer();
            let q = new HubPushQueue(indexer);
            let row = makeRow({ id: 9, payload: '{{invalid json' });
            await q.attempt(row);
            assert.strictEqual(indexer.indexerDb.recordHubPushAttempt.calledOnce, true);
            let [id, msg] = indexer.indexerDb.recordHubPushAttempt.firstCall.args;
            assert.strictEqual(id, 9);
            assert.match(msg, /unparseable payload/);
        });

        it('accepts payload that is already an object (not a string)', async function(){
            let indexer = makeIndexer();
            let q = new HubPushQueue(indexer);
            let row = makeRow({ push_type: 'price_round', payload: { round: 1 } });
            await q.attempt(row);
            assert.strictEqual(indexer.hubClient.pushPriceRound.calledOnce, true);
            assert.strictEqual(indexer.indexerDb.markHubPushDelivered.calledOnce, true);
        });

        it('calls pushPriceRound for price_round rows and marks delivered', async function(){
            let indexer = makeIndexer();
            let q = new HubPushQueue(indexer);
            let payload = { round: 5, coin: 'BTC' };
            let row = makeRow({ id: 1, push_type: 'price_round', payload: JSON.stringify(payload) });
            await q.attempt(row);
            assert.strictEqual(indexer.hubClient.pushPriceRound.calledOnce, true);
            assert.deepStrictEqual(indexer.hubClient.pushPriceRound.firstCall.args[0], payload);
            assert.strictEqual(indexer.indexerDb.markHubPushDelivered.calledWith(1), true);
        });

        it('calls pushOraclePrice for oracle_price rows and marks delivered', async function(){
            let indexer = makeIndexer();
            let q = new HubPushQueue(indexer);
            let payload = { tick: 'AAA', price: '1.00' };
            let row = makeRow({ id: 2, push_type: 'oracle_price', payload: JSON.stringify(payload) });
            await q.attempt(row);
            assert.strictEqual(indexer.hubClient.pushOraclePrice.calledOnce, true);
            assert.deepStrictEqual(indexer.hubClient.pushOraclePrice.firstCall.args[0], payload);
            assert.strictEqual(indexer.indexerDb.markHubPushDelivered.calledWith(2), true);
        });

        // ─── price_batch (PRICE batch push) ─────
        it('calls pushPriceBatch for price_batch rows and marks delivered', async function(){
            let indexer = makeIndexer();
            let q = new HubPushQueue(indexer);
            let payload = { source_chain: 'BTC', first_round: 1, last_round: 6, rounds: [], block_time: 1700000000 };
            let row = makeRow({ id: 20, push_type: 'price_batch', payload: JSON.stringify(payload) });
            await q.attempt(row);
            assert.strictEqual(indexer.hubClient.pushPriceBatch.calledOnce, true);
            assert.deepStrictEqual(indexer.hubClient.pushPriceBatch.firstCall.args[0], payload);
            assert.strictEqual(indexer.indexerDb.markHubPushDelivered.calledWith(20), true);
        });
}); }

function registerHubPushQueueGroup8() { describe('_attempt()', function(){
        it('does NOT retire a price_batch after maxAttempts failures (batch is the sole carrier of its window)', async function(){
            let indexer = makeIndexer();
            indexer.hubClient.pushPriceBatch = sinon.stub().rejects(new Error('hub down'));
            let q = new HubPushQueue(indexer, { maxAttempts: 3 });
            let row = makeRow({ id: 21, push_type: 'price_batch', attempts: 3 });
            await q.attempt(row);
            let cap = indexer.indexerDb.recordHubPushAttempt.firstCall.args[2];
            assert.strictEqual(cap, Number.MAX_SAFE_INTEGER,
                'a price_batch must be recorded with an unbounded cap so it never flips to failed');
            assert.strictEqual(indexer.indexerDb.markHubPushDelivered.callCount, 0,
                'a failed price_batch row must stay queued, never be dropped');
        });

        // ─── attest_batch (ATTEST v5/v6 response batch) ─────
        it('calls pushAttestBatch for attest_batch rows and marks delivered', async function(){
            let indexer = makeIndexer();
            let q = new HubPushQueue(indexer);
            let payload = { source_chain: 'DOGE', network: 'regtest', window_start: 1700000000,
                            window_end: 1700003600, row_count: 2, btc_block_height: 900000,
                            rows: [], sigs: [], action_index: 71, block_index: 6300000,
                            block_time: 1700004000, push_generation: 0 };
            let row = makeRow({ id: 30, push_type: 'attest_batch', payload: JSON.stringify(payload) });
            await q.attempt(row);
            assert.strictEqual(indexer.hubClient.pushAttestBatch.calledOnce, true);
            assert.deepStrictEqual(indexer.hubClient.pushAttestBatch.firstCall.args[0], payload);
            assert.strictEqual(indexer.indexerDb.markHubPushDelivered.calledWith(30), true);
        });

        it('does NOT retire an attest_batch after maxAttempts failures (the sole chain carrier of its window)', async function(){
            let indexer = makeIndexer();
            indexer.hubClient.pushAttestBatch = sinon.stub().rejects(new Error('hub down'));
            let q = new HubPushQueue(indexer, { maxAttempts: 3 });
            let row = makeRow({ id: 31, push_type: 'attest_batch', attempts: 3 });
            await q.attempt(row);
            let cap = indexer.indexerDb.recordHubPushAttempt.firstCall.args[2];
            assert.strictEqual(cap, Number.MAX_SAFE_INTEGER,
                'above the response-mirror activation a response is not its own transaction, so a ' +
                'retired batch strands a window of responses no later block re-emits');
            assert.strictEqual(indexer.indexerDb.markHubPushDelivered.callCount, 0,
                'a failed attest_batch row must stay queued, never be dropped');
        });

        // ─── attest_batch_retraction (reorg un-lands an ATTEST batch) ─────
        it('calls retractAttestBatch for attest_batch_retraction rows and marks delivered', async function(){
            let indexer = makeIndexer();
            let q = new HubPushQueue(indexer);
            let payload = { coin: 'DOGE', network: 'regtest', batch_key: 'ab'.repeat(32),
                            window_start: 1700000000, window_end: 1700003600, action_index: 71 };
            let row = makeRow({ id: 40, push_type: 'attest_batch_retraction', payload: JSON.stringify(payload) });
            await q.attempt(row);
            assert.strictEqual(indexer.hubClient.retractAttestBatch.calledOnce, true);
            // The chain is the first argument and the whole staged payload the second, so a
            // queued retry sends byte-identically what rollback.js tried live.
            assert.strictEqual(indexer.hubClient.retractAttestBatch.firstCall.args[0], 'DOGE');
            assert.deepStrictEqual(indexer.hubClient.retractAttestBatch.firstCall.args[1], payload);
            assert.strictEqual(indexer.indexerDb.markHubPushDelivered.calledWith(40), true);
        });
}); }

function registerHubPushQueueGroup9() { describe('_attempt()', function(){
        it('does NOT retire an unknown-to-the-dispatch retraction type as an unknown push_type', async function(){
            let indexer = makeIndexer();
            let q = new HubPushQueue(indexer);
            let row = makeRow({ id: 41, push_type: 'attest_batch_retraction',
                payload: JSON.stringify({ coin: 'DOGE', action_index: 71 }) });
            await q.attempt(row);
            // The failure this pins: an arm that does not exist falls through to the else,
            // which records 'unknown push_type' with a cap of 1 and retires the row on the spot.
            assert.strictEqual(indexer.indexerDb.recordHubPushAttempt.callCount, 0,
                'a dispatched retraction must never be recorded as an unknown push_type');
        });

        it('calls retractPriceRange for price_retraction rows and marks delivered (open-ended when no ceiling)', async function(){
            let indexer = makeIndexer();
            let q = new HubPushQueue(indexer);
            let payload = { coin: 'BTC', action_index: 4200 };
            let row = makeRow({ id: 7, push_type: 'price_retraction', payload: JSON.stringify(payload) });
            await q.attempt(row);
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
            await q.attempt(row);
            assert.deepStrictEqual(indexer.hubClient.retractPriceRange.firstCall.args, ['BTC', 4200, 4250, 5]);
            assert.strictEqual(indexer.indexerDb.markHubPushDelivered.calledWith(8), true);
        });

        it('calls retractXcallRange / retractMatchRange with the ceiling + generation fence', async function(){
            let indexer = makeIndexer();
            let q = new HubPushQueue(indexer);
            await q.attempt(makeRow({ id: 9,  push_type: 'xcall_retraction', payload: JSON.stringify({ coin: 'BTC', action_index: 10, last_action_index: 20, retraction_generation: 3 }) }));
            await q.attempt(makeRow({ id: 10, push_type: 'match_retraction', payload: JSON.stringify({ coin: 'BTC', action_index: 30, last_action_index: 40, retraction_generation: 4 }) }));
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
}); }

function registerHubPushQueueGroup10() { describe('_attempt()', function(){
        it('marks row failed for unknown push_type', async function(){
            let indexer = makeIndexer();
            let q = new HubPushQueue(indexer);
            let row = makeRow({ id: 3, push_type: 'mystery_type', payload: JSON.stringify({}) });
            await q.attempt(row);
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
            await q.attempt(row);
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
            await q.attempt(row);
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
            await q.attempt(row);
            let [, msg] = indexer.indexerDb.recordHubPushAttempt.firstCall.args;
            assert.strictEqual(msg.length, 480);
        });
}); }

function registerHubPushQueueGroup11() { describe('_attempt()', function(){
        it('does NOT call markHubPushDelivered on push failure', async function(){
            let indexer = makeIndexer();
            indexer.hubClient.pushPriceRound = sinon.stub().rejects(new Error('fail'));
            let q = new HubPushQueue(indexer);
            let row = makeRow({ push_type: 'price_round' });
            await q.attempt(row);
            assert.strictEqual(indexer.indexerDb.markHubPushDelivered.callCount, 0);
        });

        it('does NOT call pushPriceRound or pushOraclePrice on unknown type', async function(){
            let indexer = makeIndexer();
            let q = new HubPushQueue(indexer);
            let row = makeRow({ push_type: 'unknown' });
            await q.attempt(row);
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
            await q.attempt(row);
            console.warn = origWarn;
            // attempt 0+1=1
            assert.ok(warnMsg.includes('attempt 1/10'), 'expected "attempt 1/10" in: ' + warnMsg);
        });

        // ─── Retractions are exempt from the attempt cap ─────
        // A reorg retraction is the ONLY remaining record that the hub must prune an orphaned
        // range; retiring it to 'failed' after maxAttempts (a hub outage overlapping a reorg)
        // permanently strands stale prices / 'finalized' XCALL+DEX+bridge rows on the hub. Retractions
        // are idempotent + generation-fenced, so they must retry indefinitely, never retire.
        for(const rt of ['price_retraction', 'xcall_retraction', 'match_retraction', 'bridge_retraction', 'attest_batch_retraction']){
            it('does NOT retire a ' + rt + ' after maxAttempts failures (retries forever)', async function(){
                let indexer = makeIndexer();
                indexer.hubClient.retractPriceRange = sinon.stub().rejects(new Error('hub down'));
                indexer.hubClient.retractXcallRange = sinon.stub().rejects(new Error('hub down'));
                indexer.hubClient.retractMatchRange = sinon.stub().rejects(new Error('hub down'));
                indexer.hubClient.retractBridgeRange = sinon.stub().rejects(new Error('hub down'));
                indexer.hubClient.retractAttestBatch = sinon.stub().rejects(new Error('hub down'));
                let q = new HubPushQueue(indexer, { maxAttempts: 3 });
                // A row that has already burned through maxAttempts: a forward push would be retired.
                let row = makeRow({ id: 9, push_type: rt, attempts: 3,
                    payload: JSON.stringify({ coin: 'BTC', action_index: 50, last_action_index: 60, retraction_generation: 4 }) });
                await q.attempt(row);
                assert.ok(indexer.indexerDb.recordHubPushAttempt.calledOnce, 'recordHubPushAttempt should be called');
                let cap = indexer.indexerDb.recordHubPushAttempt.firstCall.args[2];
                assert.strictEqual(cap, Number.MAX_SAFE_INTEGER,
                    'a retraction must be recorded with an unbounded cap so it never flips to failed');
            });
        }
}); }

function registerHubPushQueueGroup12() { describe('_attempt()', function(){
        it('DOES retire a best-effort forward push at the attempt cap (unchanged)', async function(){
            let indexer = makeIndexer();
            indexer.hubClient.pushPriceRound = sinon.stub().rejects(new Error('fail'));
            let q = new HubPushQueue(indexer, { maxAttempts: 3 });
            let row = makeRow({ id: 11, push_type: 'price_round', attempts: 2 });
            await q.attempt(row);
            let cap = indexer.indexerDb.recordHubPushAttempt.firstCall.args[2];
            assert.strictEqual(cap, 3, 'a forward push keeps the finite maxAttempts cap');
        });

        // ─── oracle_price joins the unbounded set (item 4280) ─────
        // actions/price.js: a PRICE v1 oracle price is never re-emitted by a later block, so
        // "a lost oracle_price is never re-derivable" and the outbox exists to guarantee it is
        // not lost. The ~10-attempt cap retired it to 'failed' after ~30 minutes of hub outage
        // and pruneFailed deleted it, defeating that guarantee.
        it('does NOT retire an oracle_price after maxAttempts failures (never re-derivable)', async function(){
            let indexer = makeIndexer();
            indexer.hubClient.pushOraclePrice = sinon.stub().rejects(new Error('hub down'));
            let q = new HubPushQueue(indexer, { maxAttempts: 3 });
            let row = makeRow({ id: 12, push_type: 'oracle_price', attempts: 3 });
            await q.attempt(row);
            let cap = indexer.indexerDb.recordHubPushAttempt.firstCall.args[2];
            assert.strictEqual(cap, Number.MAX_SAFE_INTEGER,
                'an oracle_price must be recorded with an unbounded cap so it never flips to failed');
            assert.strictEqual(indexer.indexerDb.markHubPushDelivered.callCount, 0,
                'a failed oracle_price row must stay queued, never be dropped');
        });
}); }

// ─── pause() waits for an in-flight drain ─────
function registerHubPushQueueGroup13() { describe('pause() awaits in-flight drain', function(){
        it('does not resolve until a drain that is mid-attempt finishes', async function(){
            let indexer = makeIndexer();
            let releaseAttempt;
            // The in-flight attempt hangs on this promise until we release it.
            indexer.hubClient.pushPriceRound = sinon.stub().callsFake(() => new Promise(r => { releaseAttempt = r; }));
            indexer.indexerDb.getPendingHubPushes = sinon.stub().resolves([
                makeRow({ id: 1, push_type: 'price_round', attempts: 0, last_attempted_at: null })
            ]);
            let q = new HubPushQueue(indexer);
            let drainP = q.drain();                              // enters drain, stalls in attempt
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
}); }

describe('HubPushQueue', function(){

    afterEach(function(){
        sinon.restore();
    });

    registerHubPushQueueGroup7();
    registerHubPushQueueGroup8();
    registerHubPushQueueGroup9();
    registerHubPushQueueGroup10();
    registerHubPushQueueGroup11();
    registerHubPushQueueGroup12();
    registerHubPushQueueGroup13();
});
