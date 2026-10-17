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
 *
 * Unit: the readiness verdict and the coin node tip reader behind GET /ready.
 *
 * The two shapes these guard against both read healthy on every liveness surface:
 * an indexer frozen behind a REORG-halted decoder (decoder lag 0, because the
 * decoder tip froze at the halted height) and an indexer whose stuck block survived
 * a restart (lastBlockCommittedAt null, so stallWedged never fires again).
 */

'use strict';

const assert = require('assert');

const { readinessVerdict, blocksBehind, resolveReadyNoCommitMs,
        READY_NO_COMMIT_DEFAULT_MS } = require('../../../src/XChainIndexer/readiness/verdict.js');
const XChainIndexer = require('../../../src/XChainIndexer.js');
const { publishedStallClass } = require('../../../src/XChainIndexer/stall_health.js');
const UtxoTracker = require('../../../src/chain/utxo_tracker.js');

const NOW = 1_800_000_000_000;
const MIN = 60 * 1000;

function clean(overrides){
    return Object.assign({
        now: NOW, indexerDbUnreachable: false, wedged: false, pollSilent: false,
        decoderReorgHalted: false, barrierCeilingExceeded: false, decoderLag: 0, chainLag: 0,
        waitingOnFutureBlock: false, lastBlockCommittedAt: NOW - 5000, startedAt: NOW - 60 * MIN,
        noCommitMs: 10 * MIN
    }, overrides);
}

describe('readinessVerdict()', function(){
    it('is ready when nothing holds', function(){
        assert.deepStrictEqual(readinessVerdict(clean()).reasons, []);
        assert.strictEqual(readinessVerdict(clean()).ready, true);
    });

    it('is not ready behind a halted decoder even though decoder lag reads 0', function(){
        let v = readinessVerdict(clean({ decoderReorgHalted: true, decoderLag: 0, chainLag: 40,
                                         lastBlockCommittedAt: NOW - 20 * 60 * MIN }));
        assert.strictEqual(v.ready, false);
        assert.deepStrictEqual(v.reasons, ['decoder_reorg_halt', 'behind_tip_no_commit']);
        assert.strictEqual(v.behind, 40);
    });

    it('judges a stuck block from boot when nothing has committed since a restart', function(){
        let v = readinessVerdict(clean({ lastBlockCommittedAt: null, startedAt: NOW - 2 * 60 * MIN,
                                         decoderLag: 3800, barrierCeilingExceeded: true }));
        assert.deepStrictEqual(v.reasons, ['barrier_ceiling_exceeded', 'behind_tip_no_commit']);
        assert.strictEqual(v.noCommitForMs, 2 * 60 * MIN);
    });

    it('stays ready while catching up inside the window, and at the tip on a quiet chain', function(){
        assert.strictEqual(readinessVerdict(clean({ decoderLag: 500, lastBlockCommittedAt: NOW - 1000 })).ready, true);
        assert.strictEqual(readinessVerdict(clean({ lastBlockCommittedAt: NOW - 24 * 60 * MIN })).ready, true);
    });

    it('never calls a future-stamped block wait behind_tip_no_commit', function(){
        let v = readinessVerdict(clean({ decoderLag: 6, waitingOnFutureBlock: true,
                                         lastBlockCommittedAt: NOW - 30 * MIN }));
        assert.strictEqual(v.ready, true);
    });

    it('carries every liveness fault as a readiness fault', function(){
        let v = readinessVerdict(clean({ indexerDbUnreachable: true, wedged: true, pollSilent: true }));
        assert.deepStrictEqual(v.reasons, ['indexer_db_unreachable', 'wedged', 'poll_silent']);
    });

    it('takes the larger of decoder and chain lag, null when neither is known', function(){
        assert.strictEqual(blocksBehind(2, 9), 9);
        assert.strictEqual(blocksBehind(null, 4), 4);
        assert.strictEqual(blocksBehind(-1, null), 0);
        assert.strictEqual(blocksBehind(null, null), null);
    });

    it('resolves the no-commit window, falling back on unusable values', function(){
        assert.strictEqual(resolveReadyNoCommitMs(undefined), READY_NO_COMMIT_DEFAULT_MS);
        assert.strictEqual(resolveReadyNoCommitMs('0'), READY_NO_COMMIT_DEFAULT_MS);
        assert.strictEqual(resolveReadyNoCommitMs('abc'), READY_NO_COMMIT_DEFAULT_MS);
        assert.strictEqual(resolveReadyNoCommitMs('90000'), 90000);
    });
});

describe('XChainIndexer readiness state and readChainTip()', function(){
    it('stamps startedAt and the readiness window at construction', function(){
        let indexer = new XChainIndexer();
        assert.ok(Number.isFinite(indexer.startedAt) && indexer.startedAt > 0);
        assert.strictEqual(indexer.readyNoCommitMs, READY_NO_COMMIT_DEFAULT_MS);
        assert.strictEqual(indexer.chainTip, null);
    });

    it('reports no tip when no tracker is configured', async function(){
        let indexer = new XChainIndexer();
        assert.deepStrictEqual(await indexer.readChainTip(), { height: null, source: null, at: null });
    });

    it('reads node_height from the tracker and caches it for the TTL', async function(){
        let indexer = new XChainIndexer();
        let calls = 0;
        indexer.utxoTracker = { enabled: true, getSyncStatus: async () => { calls++; return { node_height: 812, tracker_height: 812 }; } };
        let tip = await indexer.readChainTip();
        assert.strictEqual(tip.height, 812);
        assert.strictEqual(tip.source, 'utxo_tracker');
        await indexer.readChainTip();
        assert.strictEqual(calls, 1, 'a second read inside the TTL must not re-query the tracker');
    });

    it('ignores the -1 an unsynced tracker reports and keeps the last known tip on failure', async function(){
        let indexer = new XChainIndexer();
        indexer.utxoTracker = { enabled: true, getSyncStatus: async () => ({ node_height: -1 }) };
        assert.strictEqual((await indexer.readChainTip()).height, null);
        indexer.chainTip = 700;
        indexer._chainTipCheckedAt = 0;
        indexer.utxoTracker = { enabled: true, getSyncStatus: async () => { throw new Error('ECONNREFUSED'); } };
        assert.strictEqual((await indexer.readChainTip()).height, 700);
    });

    it('answers within the timeout when the tracker hangs', async function(){
        let indexer = new XChainIndexer();
        indexer.chainTipTimeoutMs = 20;
        indexer.utxoTracker = { enabled: true, getSyncStatus: () => new Promise(() => {}) };
        let started = Date.now();
        let tip = await indexer.readChainTip();
        assert.ok(Date.now() - started < 1000, 'a hung tracker must not hold the probe');
        assert.strictEqual(tip.height, null);
    });
});

describe('publishedStallClass()', function(){
    it('names an indexer idle behind a halted decoder upstream_halted', function(){
        assert.strictEqual(publishedStallClass('none', null, { decoderReorgHalted: true }), 'upstream_halted');
        assert.strictEqual(publishedStallClass('none', null, {}), 'none');
    });

    it('gives the roll call proof wait its own class, escalating past the ceiling', function(){
        assert.strictEqual(publishedStallClass('barrier_defer', 'rollcall_proof_unavailable', {}), 'rollcall_proof_wait');
        assert.strictEqual(publishedStallClass('barrier_defer', 'rollcall_proof_unavailable', { ceilingExceeded: true }),
                           'rollcall_proof_stuck');
    });

    it('never refines a wedge away, and leaves every other class alone', function(){
        assert.strictEqual(publishedStallClass('wedged', 'rollcall_proof_unavailable', { ceilingExceeded: true }), 'wedged');
        assert.strictEqual(publishedStallClass('wedged', null, { decoderReorgHalted: true }), 'wedged');
        assert.strictEqual(publishedStallClass('barrier_defer', 'price_sync_barrier', { ceilingExceeded: true }), 'barrier_defer');
        assert.strictEqual(publishedStallClass('future_block_wait', 'price_sync_barrier', {}), 'future_block_wait');
    });
});

describe('UtxoTracker.getSyncStatus()', function(){
    let origFetch;
    beforeEach(function(){ origFetch = global.fetch; });
    afterEach(function(){ global.fetch = origFetch; });

    it('asks get_sync_status with a bounded request and returns the sync view', async function(){
        let seen = null;
        global.fetch = async (url, init) => {
            seen = init;
            return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: { node_height: 9, tracker_height: 9 } }) };
        };
        let sync = await new UtxoTracker('tracker', 3001).getSyncStatus();
        assert.strictEqual(JSON.parse(seen.body).method, 'get_sync_status');
        assert.ok(seen.signal, 'a health read must carry an abort signal');
        assert.strictEqual(sync.node_height, 9);
    });

    it('leaves consensus calls unbounded: no signal unless one is asked for', async function(){
        let seen = null;
        global.fetch = async (url, init) => {
            seen = init;
            return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: null }) };
        };
        await new UtxoTracker('tracker', 3001).getFirstSeen('addr');
        assert.strictEqual(seen.signal, undefined);
    });
});
