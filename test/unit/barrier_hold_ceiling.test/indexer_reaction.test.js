// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// test/unit/barrier_hold_ceiling.test/indexer_reaction.test.js
//
// Covers the indexer's response when a continuously deferred block crosses the hold ceiling.

const { assert, sinon, XChainIndexer, NOW } = require('./helpers/barrier_hold_ceiling.js');

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

const note = XChainIndexer.prototype.noteBarrierHold;

let err;

// ── The indexer's reaction to a crossing ───────────────────────────────────────
describe('XChainIndexer.noteBarrierHold @regression @tier1', function () {
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
});

describe('XChainIndexer.noteBarrierHold @regression @tier1', function () {
    beforeEach(function () { err = sinon.stub(console, 'error'); });
    afterEach(function () { err.restore(); });

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
