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
const { stallWedged } = require('../../src/XChainIndexer');

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
