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
 * Unit: stallWedged() /status healthcheck discriminator
 *
 * The height-keyed BTC price-sync barrier defers the newest block on almost
 * every poll, so a healthy BTC-mainnet indexer is nearly always mid-barrier
 * (stallReason set) even though it advances every few seconds. stallWedged()
 * is what lets the container /status healthcheck reserve 503 for a real wedge
 * rather than restart-looping a functioning service.
 */

'use strict';

const assert = require('assert');
const { stallWedged, waitingOnFutureBlock, stallClassOf, atProcessableTip } = require('../../src/XChainIndexer');

describe('stallWedged() healthcheck discriminator', function () {
    const GRACE = 120000; // 2 min
    const NOW   = 1_000_000_000;

    it('no stallReason is never wedged, regardless of commit age', function () {
        assert.strictEqual(stallWedged(null, NOW - 999999999, GRACE, NOW), false);
        assert.strictEqual(stallWedged(null, null, GRACE, NOW), false);
    });

    it('a stall with no committed block yet is not wedged (slow initial catch-up gets grace)', function () {
        assert.strictEqual(stallWedged('price_sync_barrier', null, GRACE, NOW), false);
    });

    it('stalled but a block committed inside the grace window is NOT wedged (advancing-degraded)', function () {
        // committed 5s ago against a 2 min grace: the BTC steady state
        assert.strictEqual(stallWedged('price_sync_barrier', NOW - 5000, GRACE, NOW), false);
    });

    it('stalled and no commit for longer than the grace window IS wedged', function () {
        // committed 10 min ago: mirror down / host fault
        assert.strictEqual(stallWedged('price_sync_barrier', NOW - 600000, GRACE, NOW), true);
        assert.strictEqual(stallWedged('vm_executor_unavailable', NOW - 600000, GRACE, NOW), true);
    });

    it('the grace boundary is exclusive: exactly at grace is not yet wedged, one ms past is', function () {
        assert.strictEqual(stallWedged('price_sync_barrier', NOW - GRACE, GRACE, NOW), false);
        assert.strictEqual(stallWedged('price_sync_barrier', NOW - GRACE - 1, GRACE, NOW), true);
    });
});

/*
 * a block stamped in the FUTURE (Bitcoin permits ~2h ahead of median-time-past,
 * and miner clocks routinely run minutes fast) defers behind the time-keyed barriers until
 * wall clock reaches its timestamp. Nothing commits for the whole skew, so against a 120s
 * grace the indexer crossed the wedge threshold in two minutes and reported 503/unhealthy
 * over an entirely valid block, fleet-wide and simultaneously, with a restart achieving
 * nothing. Observed live on BTC testnet4 block 146590 (stamped 116.5 minutes ahead).
 */
describe('stallWedged() future-stamped-block deadline', function () {
    const GRACE = 120000;
    const NOW   = 1_000_000_000;
    const LONG_STALL = NOW - 600000;   // 10 min with no commit: wedged under the old rule

    it('a stall waiting on a still-future instant is NOT wedged, however long it has stalled', function () {
        assert.strictEqual(stallWedged('price_sync_barrier', LONG_STALL, GRACE, NOW, NOW + 1), false);
        // the real shape: a 116-minute skew, far past any grace window
        assert.strictEqual(stallWedged('price_sync_barrier', LONG_STALL, GRACE, NOW, NOW + 6_990_000), false);
    });

    it('once wall clock reaches the instant, the ordinary grace verdict applies again', function () {
        // the deadline has passed and the stall persists: the mirror really is stuck
        assert.strictEqual(stallWedged('price_sync_barrier', LONG_STALL, GRACE, NOW, NOW), true);
        assert.strictEqual(stallWedged('price_sync_barrier', LONG_STALL, GRACE, NOW, NOW - 1), true);
    });

    it('the deadline suppresses the WEDGE only, never invents one', function () {
        // still advancing (committed 5s ago): not wedged either way
        assert.strictEqual(stallWedged('price_sync_barrier', NOW - 5000, GRACE, NOW, NOW + 60000), false);
        assert.strictEqual(stallWedged('price_sync_barrier', NOW - 5000, GRACE, NOW, NOW - 60000), false);
        // no stall at all: a deadline cannot make one
        assert.strictEqual(stallWedged(null, LONG_STALL, GRACE, NOW, NOW + 60000), false);
    });

    it('a null/absent/non-finite deadline preserves the pre- verdict exactly', function () {
        for (const d of [undefined, null, NaN, Infinity, -Infinity, 'soon']) {
            assert.strictEqual(stallWedged('price_sync_barrier', LONG_STALL, GRACE, NOW, d), true,
                               'wedged verdict must survive deadline=' + String(d));
            assert.strictEqual(stallWedged('price_sync_barrier', NOW - 5000, GRACE, NOW, d), false,
                               'advancing verdict must survive deadline=' + String(d));
        }
    });

    it('barriers with no wall-clock deadline (host faults) still wedge', function () {
        // vm_executor_unavailable and the presence/snapshot barriers pass null by design:
        // a host fault has no instant at which it clears on its own.
        assert.strictEqual(stallWedged('vm_executor_unavailable', LONG_STALL, GRACE, NOW, null), true);
        assert.strictEqual(stallWedged('call_presence_barrier',   LONG_STALL, GRACE, NOW, null), true);
    });
});

/*
 * Telling the healthy future-stamped-block wait apart from degradation.
 *
 * Measured on BTC testnet4: the miner stamps each block ~20 min ahead of the previous
 * one, riding the consensus 2-hour future-time cap, so the time-keyed barriers hold the
 * head block until wall clock reaches its stamp. Lag pins at ~6 blocks forever and the
 * indexer commits each block in milliseconds the moment it becomes processable. On the
 * old surface that reads as isSynced:false + degraded:true + a named stallReason, i.e.
 * a permanent fault to any monitor. These pin the discriminators that say otherwise.
 */
describe('waitingOnFutureBlock() / stallClassOf() / atProcessableTip()', function () {
    const GRACE = 120000;
    const NOW   = 1_000_000_000;
    const LONG_STALL = NOW - 900000;   // 15 min with no commit
    const RECENT     = NOW - 5000;

    describe('waitingOnFutureBlock()', function () {
        it('a still-future clear instant with a stall set is a future-block wait', function () {
            assert.strictEqual(waitingOnFutureBlock('anchor_attest_barrier', NOW + 1, NOW), true);
            // the real shape: a 16 minute skew
            assert.strictEqual(waitingOnFutureBlock('anchor_attest_barrier', NOW + 960000, NOW), true);
        });

        it('no stall is never a future-block wait, however far ahead the instant', function () {
            assert.strictEqual(waitingOnFutureBlock(null, NOW + 960000, NOW), false);
        });

        it('a reached or passed instant is no longer a wait', function () {
            assert.strictEqual(waitingOnFutureBlock('anchor_attest_barrier', NOW, NOW), false);
            assert.strictEqual(waitingOnFutureBlock('anchor_attest_barrier', NOW - 1, NOW), false);
        });

        it('barriers with no wall-clock instant are never a future-block wait', function () {
            for (const d of [undefined, null, NaN, Infinity, -Infinity, 'soon']) {
                assert.strictEqual(waitingOnFutureBlock('call_presence_barrier', d, NOW), false,
                                   'must not claim a future wait for stallClearsAt=' + String(d));
            }
        });
    });

    describe('stallClassOf()', function () {
        it('no stall classifies as none', function () {
            assert.strictEqual(stallClassOf(null, RECENT, GRACE, NOW, null), 'none');
            assert.strictEqual(stallClassOf(null, LONG_STALL, GRACE, NOW, NOW + 960000), 'none');
        });

        it('the testnet4 steady state classifies as future_block_wait, not wedged', function () {
            // no commit for 15 min against a 2 min grace, but the head block is stamped
            // 16 min ahead: the old surface called this a wedge-shaped degradation
            assert.strictEqual(stallClassOf('anchor_attest_barrier', LONG_STALL, GRACE, NOW, NOW + 960000),
                               'future_block_wait');
        });

        it('an advancing barrier defer with no wall-clock instant classifies as barrier_defer', function () {
            assert.strictEqual(stallClassOf('price_sync_barrier', RECENT, GRACE, NOW, null), 'barrier_defer');
        });

        it('a real wedge still classifies as wedged', function () {
            assert.strictEqual(stallClassOf('vm_executor_unavailable', LONG_STALL, GRACE, NOW, null), 'wedged');
            // and once the clear instant has passed and the stall persists
            assert.strictEqual(stallClassOf('anchor_attest_barrier', LONG_STALL, GRACE, NOW, NOW - 1), 'wedged');
        });

        it('the class never contradicts stallWedged()', function () {
            const cases = [
                ['anchor_attest_barrier', LONG_STALL, NOW + 960000],
                ['anchor_attest_barrier', LONG_STALL, NOW - 1],
                ['price_sync_barrier',    RECENT,     null],
                ['vm_executor_unavailable', LONG_STALL, null],
                [null,                    LONG_STALL, null]
            ];
            for (const [reason, committedAt, clearsAt] of cases) {
                const wedged = stallWedged(reason, committedAt, GRACE, NOW, clearsAt);
                const cls    = stallClassOf(reason, committedAt, GRACE, NOW, clearsAt);
                assert.strictEqual(cls === 'wedged', wedged,
                                   `class ${cls} disagrees with stallWedged=${wedged} for ${String(reason)}`);
            }
        });
    });

    describe('atProcessableTip()', function () {
        it('level with the decoder tip is at the processable tip', function () {
            assert.strictEqual(atProcessableTip(true, null, null, NOW), true);
        });

        it('a future-stamped block in the way still counts as caught up', function () {
            // the point of the field: lag is 6, isSynced is false, and the indexer holds
            // every block consensus permits it to hold
            assert.strictEqual(atProcessableTip(false, 'anchor_attest_barrier', NOW + 960000, NOW), true);
        });

        it('an ordinary catch-up or mirror-lag defer is NOT at the processable tip', function () {
            assert.strictEqual(atProcessableTip(false, null, null, NOW), false);
            assert.strictEqual(atProcessableTip(false, 'price_sync_barrier', null, NOW), false);
            assert.strictEqual(atProcessableTip(false, 'anchor_attest_barrier', NOW - 1, NOW), false);
        });
    });
});
