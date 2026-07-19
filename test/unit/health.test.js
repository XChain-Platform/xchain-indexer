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
 * test/unit/health.test.js
 *
 * Unit tests for the health() response builder (src/health.js).
 *
 * The health endpoint reports a growing `lag` when the indexer is not
 * advancing. A bare lag value is ambiguous: a hub-sync-barrier stall, a
 * tripped DB circuit breaker, and a VM executor host fault all present
 * identically. These tests pin down the discriminators (`stallReason`
 * plus the two circuit-state fields) so an operator can tell them apart.
 */

'use strict';

const assert = require('assert');

const { buildHealthResponse } = require('../../src/health');

// Build a stub indexer with sane defaults; override any field per-test. Both
// DB connections default to a closed (healthy) circuit and the indexer is mid
// catch-up (decoder ahead of the last indexed block) so `lag` is non-zero.
// hubPushQueue is omitted so buildHealthResponse takes the null-safe branch
// (no DB call) and resolves immediately.
function makeIndexer(overrides = {}){
    return Object.assign({
        decoderDb:            { circuitState: 'closed' },
        indexerDb:            { circuitState: 'closed' },
        lastDecoderBlock:     200,
        lastHubConfigFetchAt: null,
        stallReason:          null,
        isSynced:             () => false
    }, overrides);
}

function call(indexer, opts = {}){
    return buildHealthResponse(Object.assign({
        indexer,
        indexerRunning:   true,
        indexerError:     null,
        lastIndexedBlock: 190,
        now:              1_000_000
    }, opts));
}

describe('health() response builder', function(){

    it('(a) healthy catch-up: stallReason is null, status healthy, lag reported', async function(){
        const res = await call(makeIndexer());
        assert.strictEqual(res.status, 'healthy');
        assert.strictEqual(res.running, true);
        assert.strictEqual(res.stallReason, null);
        assert.strictEqual(res.lag, 10);               // 200 - 190
        assert.strictEqual(res.decoderDbCircuit, 'closed');
        assert.strictEqual(res.indexerDbCircuit, 'closed');
    });

    it('(b) sync-barrier stall: stallReason names the barrier while status stays healthy', async function(){
        // A barrier timeout does not trip a circuit. Both DBs are reachable;
        // the indexer is simply waiting on the hub mirror. lag grows, but the
        // operator can now read WHY from stallReason rather than guessing.
        const res = await call(makeIndexer({ stallReason: 'price_sync_barrier' }));
        assert.strictEqual(res.stallReason, 'price_sync_barrier');
        assert.strictEqual(res.status, 'healthy');
        assert.strictEqual(res.decoderDbCircuit, 'closed');
        assert.strictEqual(res.indexerDbCircuit, 'closed');
    });

    it('(c) DB circuit-breaker tripped: stallReason null, circuit open, status unhealthy', async function(){
        // A breaker trip is a distinct stall mode: stallReason stays null, and
        // the open circuit field plus the unhealthy status flag the cause.
        const res = await call(makeIndexer({ indexerDb: { circuitState: 'open' } }));
        assert.strictEqual(res.stallReason, null);
        assert.strictEqual(res.indexerDbCircuit, 'open');
        assert.strictEqual(res.status, 'unhealthy');
    });

    it('(d) VM executor host fault: stallReason flags the halt with circuits closed', async function(){
        // The host-fault halt sets stallReason without tripping a circuit, so it
        // is distinguishable from both a barrier stall and a breaker trip.
        const res = await call(makeIndexer({ stallReason: 'vm_executor_unavailable' }));
        assert.strictEqual(res.stallReason, 'vm_executor_unavailable');
        assert.strictEqual(res.decoderDbCircuit, 'closed');
        assert.strictEqual(res.indexerDbCircuit, 'closed');
        assert.strictEqual(res.status, 'healthy');
    });

    it('surfaces hub-config age in seconds from the fixed clock', async function(){
        const res = await call(makeIndexer({ lastHubConfigFetchAt: 1_000_000 - 45_000 }));
        assert.strictEqual(res.hubConfigAgeSeconds, 45);
        assert.strictEqual(res.lastHubConfigFetchAt, 955_000);
    });

    it('reports a fatal indexer error message and unhealthy status when not running', async function(){
        const res = await call(makeIndexer(), {
            indexerRunning: false,
            indexerError:   new Error('boom')
        });
        assert.strictEqual(res.status, 'unhealthy');
        assert.strictEqual(res.running, false);
        assert.strictEqual(res.error, 'boom');
    });

    it('action_counters is null when the actions instance is not yet initialised', async function(){
        // During early boot the actions object may not exist yet. The health response
        // must not throw; it should surface null so a monitoring probe can tell the
        // counters are simply unavailable, not zero.
        const res = await call(makeIndexer());
        assert.strictEqual(res.action_counters, null, 'should be null when indexer.actions is absent');
    });

    it('action_counters reflects a live snapshot from getActionCounters()', async function(){
        const counters = { ISSUE: { accepted: 3, rejected: 1 }, SEND: { accepted: 7, rejected: 0 } };
        const indexer  = makeIndexer({
            actions: { getActionCounters: () => Object.assign({}, counters) }
        });
        const res = await call(indexer);
        assert.deepStrictEqual(res.action_counters, counters,
            'action_counters must mirror the live snapshot from getActionCounters()');
    });

    it('surfaces reorg counters from reorgStats (#1813)', async function(){
        const res = await call(makeIndexer(), {
            reorgStats: { reorgsProcessed: 3, lastReorgBlock: 6_241_887, lastReorgAt: 1_720_800_000_000 }
        });
        assert.strictEqual(res.reorgsProcessed, 3);
        assert.strictEqual(res.lastReorgBlock, 6_241_887);
        assert.strictEqual(res.lastReorgAt, 1_720_800_000_000);
    });

    it('reorg counters are null when reorgStats is omitted (DB unread)', async function(){
        const res = await call(makeIndexer());
        assert.strictEqual(res.reorgsProcessed, null);
        assert.strictEqual(res.lastReorgBlock, null);
        assert.strictEqual(res.lastReorgAt, null);
    });

    it('decoderReorgHalted false by default, no stall attribution (#2736)', async function(){
        const res = await call(makeIndexer());
        assert.strictEqual(res.decoderReorgHalted, false);
        assert.strictEqual(res.stallReason, null);
    });

    it('decoder halt: decoderReorgHalted true and stallReason attributes the halt (#2736)', async function(){
        const res = await call(makeIndexer({ decoderReorgHalted: true }));
        assert.strictEqual(res.decoderReorgHalted, true);
        assert.ok(/decoder_reorg_halt/.test(res.stallReason),
            'stallReason must attribute the stall to the decoder halt, got ' + JSON.stringify(res.stallReason));
    });

    it('decoder halt does not clobber an existing indexer-side stallReason (#2736)', async function(){
        const res = await call(makeIndexer({ decoderReorgHalted: true, stallReason: 'price-barrier-timeout' }));
        assert.strictEqual(res.decoderReorgHalted, true);
        assert.strictEqual(res.stallReason, 'price-barrier-timeout');
    });

});
