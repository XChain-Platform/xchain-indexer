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

const {
    assert, sinon, HUB_SYNC_BARRIER_HOLD_CEILING_S,
    resolveBarrierHoldCeilingMs, nextBarrierHold, barrierHoldMs,
    barrierCeilingExceeded, isMirrorBarrierReason, NOW
} = require('./barrier_hold_ceiling.test/helpers/barrier_hold_ceiling.js');

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
});

describe('nextBarrierHold / barrierHoldMs @regression @tier1', function () {
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

    const INDEXER_SRC = require('../../helpers/indexer_class_source.js').readIndexerClassSource();
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
