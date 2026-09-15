// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// test/unit/barrier_hold_ceiling.test/resync_and_reporting.test.js
//
// Covers forced mirror resync behavior and the source wiring that reports held blocks.

const {
    assert, fs, path, sinon, HubDbSync, HUB_SYNC_BARRIER_HOLD_CEILING_S
} = require('./helpers/barrier_hold_ceiling.js');

function makeSync() {
    const doQuery = sinon.stub().callsFake(async () => []);
    const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test' });
    return sync;
}
function fakeSocket() {
    return { terminated: 0, closed: 0, terminate() { this.terminated++; }, close() { this.closed++; } };
}

let warn;

// ── The remedy: HubDbSync.requestResync ────────────────────────────────────────
describe('HubDbSync.requestResync @regression @tier1', function () {
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
        const boot = sinon.stub(sync, 'bootstrapAll').resolves();
        assert.strictEqual(sync.requestResync('poll mode'), true);
        await new Promise(r => setImmediate(r));
        assert.strictEqual(boot.callCount, 1);
    });

    it('swallows a failing forced bootstrap rather than rejecting into the block loop', async function () {
        const sync = makeSync();
        sync.running = true;
        sync.ws = null;
        sinon.stub(sync, 'bootstrapAll').rejects(new Error('hub down'));
        assert.strictEqual(sync.requestResync('poll mode'), true);
        await new Promise(r => setImmediate(r));
        await new Promise(r => setImmediate(r));
        assert.ok(warn.getCalls().some(c => String(c.args[0]).includes('forced resync bootstrap failed')));
    });
});

describe('HubDbSync.requestResync @regression @tier1', function () {
    beforeEach(function () { warn = sinon.stub(console, 'warn'); });
    afterEach(function () { warn.restore(); });

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

    const INDEXER_SRC = fs.readFileSync(path.resolve(__dirname, '../../../src/XChainIndexer.js'), 'utf8');

    it('the poll loop folds the hold once the catch-up loop stops', function () {
        assert.ok(/this\.noteBarrierHold\(/.test(INDEXER_SRC),
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

    const HEALTH_SRC = fs.readFileSync(path.resolve(__dirname, '../../../src/api/health.js'), 'utf8');

    it('reports the hold, the block it holds, the ceiling and the crossings', function () {
        for (const field of ['barrierHoldMs:', 'barrierHoldBlock:', 'barrierHoldCeilingMs:',
                             'barrierCeilingExceeded:', 'barrierCeilingHits:'])
            assert.ok(HEALTH_SRC.includes(field), 'health must report ' + field);
    });
});
