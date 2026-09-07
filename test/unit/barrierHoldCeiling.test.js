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
// The hub-mirror barriers bound one ATTEMPT and then defer, and the block loop retries
// the same block with an identical fresh wait, so the TOTAL hold has no bound of its own.
// These cover the named ceiling that bounds it, the pure fold that measures the hold, and
// the forced mirror resync the crossing drives.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const sinon  = require('sinon');

const HubDbSync = require('../../src/hub_db_sync.js');
const {
    HUB_SYNC_BARRIER_HOLD_CEILING_S,
    resolveBarrierHoldCeilingMs
} = require('../../src/hub_db_sync.js');
const XChainIndexer = require('../../src/XChainIndexer.js');
const { nextBarrierHold, barrierHoldMs, barrierCeilingExceeded,
        isMirrorBarrierReason } = require('../../src/XChainIndexer.js');

const NOW = 1800000000000;

// ── The named ceiling constant and its resolver ────────────────────────────────
describe('mirror-barrier hold ceiling constant @regression @tier1', function () {

    const ENV_KEY = 'HUB_SYNC_BARRIER_HOLD_CEILING_S';
    let saved;
    beforeEach(function () { saved = process.env[ENV_KEY]; delete process.env[ENV_KEY]; });
    afterEach(function () {
        if (saved === undefined) delete process.env[ENV_KEY];
        else process.env[ENV_KEY] = saved;
    });

    it('names a ceiling rather than leaving the hold unbounded', function () {
        assert.strictEqual(typeof HUB_SYNC_BARRIER_HOLD_CEILING_S, 'number');
        assert.ok(Number.isFinite(HUB_SYNC_BARRIER_HOLD_CEILING_S) && HUB_SYNC_BARRIER_HOLD_CEILING_S > 0,
            'the ceiling must be a finite positive number of seconds');
    });

    // A ceiling at or below one barrier-attempt timeout would fire on the first ordinary
    // defer, which is exactly the healthy case this must not touch.
    it('sits well above one barrier-attempt timeout and one reconnect-plus-drain cycle', function () {
        assert.ok(HUB_SYNC_BARRIER_HOLD_CEILING_S * 1000 > 60000 * 2,
            'the ceiling must exceed several 60s barrier-attempt cycles');
    });

    it('resolves to the named default in milliseconds when unset', function () {
        assert.strictEqual(resolveBarrierHoldCeilingMs(), HUB_SYNC_BARRIER_HOLD_CEILING_S * 1000);
    });

    // Operational, not consensus: it opens no barrier, so a per-node value cannot fork
    // settlement and the override is honored everywhere rather than on regtest alone.
    it('honors an operator override on any network', function () {
        assert.strictEqual(resolveBarrierHoldCeilingMs('30'), 30000);
        process.env[ENV_KEY] = '45';
        assert.strictEqual(resolveBarrierHoldCeilingMs(), 45000);
    });

    it('treats 0 as the documented off switch', function () {
        assert.strictEqual(resolveBarrierHoldCeilingMs('0'), 0);
        assert.strictEqual(barrierCeilingExceeded({ since: 0 }, 0, NOW), false,
            'a disabled ceiling never reports a crossing');
    });

    // A bad value here can only mis-time a log line, so it must never keep an indexer
    // from booting the way an unparseable consensus grace deliberately does.
    it('falls back to the default on an unusable value instead of throwing', function () {
        const log = sinon.stub(console, 'log');
        try {
            assert.strictEqual(resolveBarrierHoldCeilingMs('later'), HUB_SYNC_BARRIER_HOLD_CEILING_S * 1000);
            assert.strictEqual(resolveBarrierHoldCeilingMs('-5'),    HUB_SYNC_BARRIER_HOLD_CEILING_S * 1000);
            assert.strictEqual(resolveBarrierHoldCeilingMs('1.5'),   HUB_SYNC_BARRIER_HOLD_CEILING_S * 1000);
            assert.ok(log.called, 'an ignored override must say so');
        } finally { log.restore(); }
    });
});

// ── The pure fold that measures the hold ───────────────────────────────────────
describe('nextBarrierHold / barrierHoldMs @regression @tier1', function () {

    it('starts a hold when a block is deferred behind a barrier', function () {
        const hold = nextBarrierHold(null, 900, 'attest_response_sync_barrier', null, NOW);
        assert.deepStrictEqual(hold, { block: 900, reason: 'attest_response_sync_barrier', since: NOW, notified: false });
        assert.strictEqual(barrierHoldMs(hold, NOW + 5000), 5000);
    });

    // The whole point: a retry must not restart the clock, or the hold can never reach
    // any ceiling and each pass looks like a fresh, healthy defer.
    it('a retry of the SAME block keeps the original start instant', function () {
        const first  = nextBarrierHold(null,  900, 'attest_response_sync_barrier', null, NOW);
        const second = nextBarrierHold(first, 900, 'attest_response_sync_barrier', null, NOW + 60000);
        assert.strictEqual(second.since, NOW, 'a retry must not reset the hold');
        assert.strictEqual(barrierHoldMs(second, NOW + 60000), 60000);
    });

    // Keyed on the block, not the reason: a block that cycles between the price barrier
    // and the attestation-response barrier is still one stuck block.
    it('a block that cycles between two barriers keeps accumulating', function () {
        const first  = nextBarrierHold(null,  900, 'price_sync_barrier', null, NOW);
        const second = nextBarrierHold(first, 900, 'attest_response_sync_barrier', null, NOW + 30000);
        assert.strictEqual(second.since, NOW);
        assert.strictEqual(second.reason, 'attest_response_sync_barrier', 'the reason reported is the current one');
    });

    it('a different block at the head of the queue restarts the hold', function () {
        const first  = nextBarrierHold(null,  900, 'attest_response_sync_barrier', null, NOW);
        const second = nextBarrierHold(first, 901, 'attest_response_sync_barrier', null, NOW + 60000);
        assert.strictEqual(second.since, NOW + 60000);
        assert.strictEqual(second.notified, false, 'a new block gets its own crossing announcement');
    });

    it('no stall reason clears the hold', function () {
        const first = nextBarrierHold(null, 900, 'attest_response_sync_barrier', null, NOW);
        assert.strictEqual(nextBarrierHold(first, 900, null, null, NOW + 60000), null);
        assert.strictEqual(barrierHoldMs(null, NOW), 0);
    });

    it('no block at the head of the queue clears the hold', function () {
        const first = nextBarrierHold(null, 900, 'attest_response_sync_barrier', null, NOW);
        assert.strictEqual(nextBarrierHold(first, null, 'attest_response_sync_barrier', null, NOW + 60000), null);
    });

    // A future-stamped block already has a named bound (its own timestamp) and no mirror
    // action can shorten it, so counting it here would fire the ceiling on the healthiest
    // steady state there is.
    it('a future-stamped block is NOT a hold, however long it waits', function () {
        const hold = nextBarrierHold(null, 900, 'attest_response_sync_barrier', NOW + 7200000, NOW);
        assert.strictEqual(hold, null);
        const carried = nextBarrierHold({ block: 900, reason: 'x', since: NOW - 999999, notified: false },
                                        900, 'attest_response_sync_barrier', NOW + 7200000, NOW);
        assert.strictEqual(carried, null, 'an existing hold is dropped once the wait is a future-stamp wait');
    });

    it('resumes accounting once the block stamp is no longer in the future', function () {
        const hold = nextBarrierHold(null, 900, 'attest_response_sync_barrier', NOW - 1, NOW);
        assert.ok(hold, 'a clear instant already in the past is a real hold');
        assert.strictEqual(hold.since, NOW);
    });

    it('the notified flag survives a retry so a crossing is announced once', function () {
        const first = { block: 900, reason: 'attest_response_sync_barrier', since: NOW, notified: true };
        assert.strictEqual(nextBarrierHold(first, 900, 'attest_response_sync_barrier', null, NOW + 1000).notified, true);
    });

    it('reports a crossing exactly at the ceiling, not one pass later', function () {
        const hold = { block: 900, reason: 'r', since: NOW, notified: false };
        assert.strictEqual(barrierCeilingExceeded(hold, 900000, NOW + 899999), false);
        assert.strictEqual(barrierCeilingExceeded(hold, 900000, NOW + 900000), true);
    });
});

// ── Which stalls a mirror resync could actually clear ──────────────────────────
//
// Read off the live source rather than a hand-copied list, so a renamed or added
// stall reason is judged by this rule instead of drifting past it.
describe('isMirrorBarrierReason @regression @tier1', function () {

    const INDEXER_SRC = fs.readFileSync(path.resolve(__dirname, '../../src/XChainIndexer.js'), 'utf8');
    const REASONS = [...new Set(
        [...INDEXER_SRC.matchAll(/this\.stallReason = '([a-z_]+)'/g)].map(m => m[1]))];

    const HOST_FAULTS = ['vm_executor_unavailable', 'anchor_reward_proof_unavailable',
                         'rollcall_proof_unavailable'];

    it('finds every stall reason the block loop actually sets', function () {
        assert.ok(REASONS.length >= 10, 'expected the full set of defer sites, got ' + REASONS.join(','));
        for (const f of HOST_FAULTS) assert.ok(REASONS.includes(f), 'missing host fault ' + f);
    });

    it('classifies every mirror barrier as resync-able and every host fault as not', function () {
        for (const reason of REASONS) {
            const expected = !HOST_FAULTS.includes(reason);
            assert.strictEqual(isMirrorBarrierReason(reason), expected,
                reason + ' is classified wrongly; a host fault must not force a hub-mirror resync');
        }
    });

    it('is total on junk input', function () {
        for (const bad of [null, undefined, 42, {}, ''])
            assert.strictEqual(isMirrorBarrierReason(bad), false);
    });
});

// ── The indexer's reaction to a crossing ───────────────────────────────────────
describe('XChainIndexer._noteBarrierHold @regression @tier1', function () {

    function makeIndexer(ceilingMs) {
        return {
            stallReason: 'attest_response_sync_barrier',
            stallClearsAt: null,
            barrierHold: null,
            barrierCeilingHits: 0,
            barrierHoldCeilingMs: ceilingMs,
            resyncCalls: [],
            hubDbSync: {
                requestResync(reason) { this.owner.resyncCalls.push(reason); return true; }
            }
        };
    }
    function wire(ix) { ix.hubDbSync.owner = ix; return ix; }

    const note = XChainIndexer.prototype._noteBarrierHold;

    let err;
    beforeEach(function () { err = sinon.stub(console, 'error'); });
    afterEach(function () { err.restore(); });

    it('an ordinary defer inside the ceiling neither logs nor re-drives the mirror', function () {
        const ix = wire(makeIndexer(900000));
        assert.strictEqual(note.call(ix, 900, NOW), 0);
        assert.strictEqual(note.call(ix, 900, NOW + 60000), 60000);
        assert.strictEqual(ix.barrierCeilingHits, 0);
        assert.deepStrictEqual(ix.resyncCalls, []);
        assert.strictEqual(err.called, false);
    });

    it('crossing the ceiling logs once and forces a mirror resync', function () {
        const ix = wire(makeIndexer(900000));
        note.call(ix, 900, NOW);
        note.call(ix, 900, NOW + 900000);
        assert.strictEqual(ix.barrierCeilingHits, 1);
        assert.strictEqual(ix.resyncCalls.length, 1);
        assert.ok(/ceiling/i.test(String(err.firstCall.args[0])), 'the crossing must be named in the log');
        assert.ok(String(err.firstCall.args[0]).includes('attest_response_sync_barrier'),
            'the log must name the barrier that is holding the block');
    });

    // The announcement is once per block, but the remedy keeps being asked for: HubDbSync
    // throttles it on the same ceiling, so a mirror that recovers and re-stalls is re-driven.
    it('keeps asking for a resync while the hold persists, but announces once', function () {
        const ix = wire(makeIndexer(900000));
        note.call(ix, 900, NOW);
        note.call(ix, 900, NOW + 900000);
        note.call(ix, 900, NOW + 960000);
        note.call(ix, 900, NOW + 1020000);
        assert.strictEqual(ix.barrierCeilingHits, 1, 'one crossing, one announcement');
        assert.strictEqual(ix.resyncCalls.length, 3);
    });

    // The safety property the whole change rests on: nothing here opens a barrier.
    it('never clears the stall or lets the block through', function () {
        const ix = wire(makeIndexer(900000));
        note.call(ix, 900, NOW);
        note.call(ix, 900, NOW + 900000);
        assert.strictEqual(ix.stallReason, 'attest_response_sync_barrier',
            'the ceiling must not open the barrier; the block keeps deferring fail-closed');
    });

    it('a future-stamped block never reaches the ceiling', function () {
        const ix = wire(makeIndexer(900000));
        ix.stallClearsAt = NOW + 7200000;
        note.call(ix, 900, NOW);
        note.call(ix, 900, NOW + 3600000);
        assert.strictEqual(ix.barrierHold, null);
        assert.strictEqual(ix.barrierCeilingHits, 0);
        assert.deepStrictEqual(ix.resyncCalls, []);
    });

    it('a committed block ends the hold and the next one starts clean', function () {
        const ix = wire(makeIndexer(900000));
        note.call(ix, 900, NOW);
        ix.stallReason = null;                       // what the commit path sets
        assert.strictEqual(note.call(ix, 901, NOW + 60000), 0);
        assert.strictEqual(ix.barrierHold, null);
    });

    it('a disabled ceiling reports the hold but takes no action', function () {
        const ix = wire(makeIndexer(0));
        note.call(ix, 900, NOW);
        assert.strictEqual(note.call(ix, 900, NOW + 99999999), 99999999);
        assert.strictEqual(ix.barrierCeilingHits, 0);
        assert.deepStrictEqual(ix.resyncCalls, []);
    });

    // A host fault is not held by anything a hub resubscribe can touch, so the ceiling
    // still names it but the remedy is withheld.
    it('names a host-fault crossing but forces no resync for it', function () {
        const ix = wire(makeIndexer(900000));
        ix.stallReason = 'anchor_reward_proof_unavailable';
        note.call(ix, 900, NOW);
        note.call(ix, 900, NOW + 900000);
        assert.strictEqual(ix.barrierCeilingHits, 1, 'the hold is still bounded and reported');
        assert.deepStrictEqual(ix.resyncCalls, [], 'a host fault must not force a hub-mirror resync');
        assert.ok(/host fault/i.test(String(err.firstCall.args[0])));
    });

    it('tolerates a mirror that predates requestResync', function () {
        const ix = wire(makeIndexer(900000));
        ix.hubDbSync = {};
        note.call(ix, 900, NOW);
        assert.doesNotThrow(() => note.call(ix, 900, NOW + 900000));
        assert.strictEqual(ix.barrierCeilingHits, 1);
    });

    it('tolerates no mirror at all', function () {
        const ix = wire(makeIndexer(900000));
        ix.hubDbSync = null;
        note.call(ix, 900, NOW);
        assert.doesNotThrow(() => note.call(ix, 900, NOW + 900000));
    });
});

// ── The remedy: HubDbSync.requestResync ────────────────────────────────────────
describe('HubDbSync.requestResync @regression @tier1', function () {

    function makeSync() {
        const doQuery = sinon.stub().callsFake(async () => []);
        const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test' });
        return sync;
    }
    function fakeSocket() {
        return { terminated: 0, closed: 0, terminate() { this.terminated++; }, close() { this.closed++; } };
    }

    let warn;
    beforeEach(function () { warn = sinon.stub(console, 'warn'); });
    afterEach(function () { warn.restore(); });

    it('reads the same named ceiling the block loop crosses on', function () {
        assert.strictEqual(makeSync().barrierHoldCeilingMs, HUB_SYNC_BARRIER_HOLD_CEILING_S * 1000);
    });

    it('is a no-op on a mirror that was never started', function () {
        const sync = makeSync();
        assert.strictEqual(sync.requestResync('test'), false);
        assert.strictEqual(sync.forcedResyncCount, 0);
    });

    it('terminates the live socket so the reconnect path re-bootstraps', function () {
        const sync = makeSync();
        sync.running = true;
        const ws = fakeSocket();
        sync.ws = ws;
        assert.strictEqual(sync.requestResync('held past the ceiling'), true);
        assert.strictEqual(ws.terminated, 1, 'terminate(), not close(): a half-open socket never finishes a handshake');
        assert.strictEqual(sync.forcedResyncCount, 1);
    });

    // Called on every deferring poll tick, so without the throttle a wedged mirror would
    // be reconnect-stormed rather than re-driven on a known cadence.
    it('throttles to one resync per ceiling window', function () {
        const sync = makeSync();
        sync.running = true;
        sync.ws = fakeSocket();
        assert.strictEqual(sync.requestResync('first'), true);
        assert.strictEqual(sync.requestResync('second'), false);
        assert.strictEqual(sync.forcedResyncCount, 1);
        // Age the last request past the ceiling: the next ask goes through.
        sync._lastResyncRequestAt = Date.now() - sync.barrierHoldCeilingMs - 1;
        assert.strictEqual(sync.requestResync('third'), true);
        assert.strictEqual(sync.forcedResyncCount, 2);
    });

    it('re-drives the bootstrap directly when there is no live socket', async function () {
        const sync = makeSync();
        sync.running = true;
        sync.ws = null;
        const boot = sinon.stub(sync, '_bootstrapAll').resolves();
        assert.strictEqual(sync.requestResync('poll mode'), true);
        await new Promise(r => setImmediate(r));
        assert.strictEqual(boot.callCount, 1);
    });

    it('swallows a failing forced bootstrap rather than rejecting into the block loop', async function () {
        const sync = makeSync();
        sync.running = true;
        sync.ws = null;
        sinon.stub(sync, '_bootstrapAll').rejects(new Error('hub down'));
        assert.strictEqual(sync.requestResync('poll mode'), true);
        await new Promise(r => setImmediate(r));
        await new Promise(r => setImmediate(r));
        assert.ok(warn.getCalls().some(c => String(c.args[0]).includes('forced resync bootstrap failed')));
    });

    it('a disabled ceiling disables the forced resync too', function () {
        const sync = makeSync();
        sync.running = true;
        sync.ws = fakeSocket();
        sync.barrierHoldCeilingMs = 0;
        assert.strictEqual(sync.requestResync('test'), false);
    });
});

// ── The wiring: the ceiling is useless if the block loop never folds the hold ───
describe('mirror-barrier hold is wired into the block loop @regression @tier1', function () {

    const INDEXER_SRC = fs.readFileSync(path.resolve(__dirname, '../../src/XChainIndexer.js'), 'utf8');

    it('the poll loop folds the hold once the catch-up loop stops', function () {
        assert.ok(/this\._noteBarrierHold\(/.test(INDEXER_SRC),
            'the block loop must call _noteBarrierHold or the ceiling is never measured');
    });

    it('a successful commit clears the hold alongside the stall reason', function () {
        const commit = INDEXER_SRC.indexOf('this.lastBlockCommittedAt = Date.now();');
        assert.notStrictEqual(commit, -1);
        assert.ok(INDEXER_SRC.slice(commit, commit + 600).includes('this.barrierHold = null;'),
            'the commit path must end the hold immediately');
    });
});

// ── Health reporting ───────────────────────────────────────────────────────────
describe('health exposes the hold and its ceiling @regression @tier1', function () {

    const HEALTH_SRC = fs.readFileSync(path.resolve(__dirname, '../../src/health.js'), 'utf8');

    it('reports the hold, the block it holds, the ceiling and the crossings', function () {
        for (const field of ['barrierHoldMs:', 'barrierHoldBlock:', 'barrierHoldCeilingMs:',
                             'barrierCeilingExceeded:', 'barrierCeilingHits:'])
            assert.ok(HEALTH_SRC.includes(field), 'health must report ' + field);
    });
});
