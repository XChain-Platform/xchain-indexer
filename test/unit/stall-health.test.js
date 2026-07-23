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

describe('stallWedged() healthcheck discriminator ', function () {
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
