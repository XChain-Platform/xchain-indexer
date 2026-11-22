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
 * Unit: a running reorg rollback is graded from its own start, with its own grace.
 *
 * The rollback is one database transaction inside one poll pass, so no commit lands and
 * no barrier hold is recorded while it runs. Without a window of its own it was timed
 * from the last commit, which on a slow chain is already older than the stall grace when
 * the reorg is detected, and a restart discards the whole transaction.
 */

'use strict';

const assert = require('assert');
const {
    REORG_ROLLBACK_REASON, stallWedged, stallClassOf, stallWindowSince, resolveRollbackGraceMs,
    waitingOnFutureBlock
} = require('../../../../src/XChainIndexer/stall_health.js');

const MIN            = 60 * 1000;
const GRACE          = 2 * MIN;
const ROLLBACK_GRACE = 10 * MIN;
const NOW            = 1700000000000;
const LAST_COMMIT    = NOW - 30 * MIN;

function wedged(reason, sinceMs, rollbackGraceMs, clearsAt = null){
    return stallWedged(reason, LAST_COMMIT, GRACE, NOW, clearsAt, null, sinceMs, null, rollbackGraceMs);
}

function classOf(reason, sinceMs, rollbackGraceMs, clearsAt = null){
    return stallClassOf(reason, LAST_COMMIT, GRACE, NOW, clearsAt, null, sinceMs, null, rollbackGraceMs);
}

describe('stall grading of an in-progress reorg rollback', function(){
    it('names the reason the rollback raises', function(){
        assert.strictEqual(REORG_ROLLBACK_REASON, 'reorg_rollback');
    });

    it('control: a rollback with no window of its own wedges from a 30 minute old commit', function(){
        assert.strictEqual(wedged(REORG_ROLLBACK_REASON, null, ROLLBACK_GRACE), true);
        assert.strictEqual(classOf(REORG_ROLLBACK_REASON, null, ROLLBACK_GRACE), 'wedged');
    });

    it('does not wedge a rollback that started a second ago', function(){
        assert.strictEqual(wedged(REORG_ROLLBACK_REASON, NOW - 1000, ROLLBACK_GRACE), false);
        assert.strictEqual(classOf(REORG_ROLLBACK_REASON, NOW - 1000, ROLLBACK_GRACE), 'barrier_defer');
    });

    it('keeps a rollback running past the stall grace but inside its own grace healthy', function(){
        assert.strictEqual(wedged(REORG_ROLLBACK_REASON, NOW - 5 * MIN, ROLLBACK_GRACE), false);
        assert.strictEqual(classOf(REORG_ROLLBACK_REASON, NOW - 5 * MIN, ROLLBACK_GRACE), 'barrier_defer');
    });

    it('wedges a rollback that outlasts its own grace', function(){
        assert.strictEqual(wedged(REORG_ROLLBACK_REASON, NOW - 11 * MIN, ROLLBACK_GRACE), true);
        assert.strictEqual(classOf(REORG_ROLLBACK_REASON, NOW - 11 * MIN, ROLLBACK_GRACE), 'wedged');
    });

    it('falls back to the stall grace when no rollback grace is given', function(){
        assert.strictEqual(wedged(REORG_ROLLBACK_REASON, NOW - 3 * MIN, null), true);
        assert.strictEqual(wedged(REORG_ROLLBACK_REASON, NOW - 1 * MIN, null), false);
    });

    it('applies the rollback grace to no other reason', function(){
        assert.strictEqual(wedged('vm_executor_unavailable', NOW - 5 * MIN, ROLLBACK_GRACE), true);
        assert.strictEqual(wedged('price_sync_barrier', NOW - 5 * MIN, ROLLBACK_GRACE), true);
    });

    it('does not read a rollback as a future wait once the stale deadline is cleared', function(){
        const stale = NOW + 40 * MIN;
        assert.strictEqual(waitingOnFutureBlock(REORG_ROLLBACK_REASON, stale, NOW), true);
        assert.strictEqual(classOf(REORG_ROLLBACK_REASON, NOW - 1000, ROLLBACK_GRACE, stale), 'future_block_wait');
        assert.strictEqual(waitingOnFutureBlock(REORG_ROLLBACK_REASON, null, NOW), false);
        assert.strictEqual(classOf(REORG_ROLLBACK_REASON, NOW - 1000, ROLLBACK_GRACE, null), 'barrier_defer');
    });
});

describe('stallWindowSince', function(){
    it('returns the rollback start while the rollback reason is raised', function(){
        const ix = { stallReason: REORG_ROLLBACK_REASON, rollbackStartedAt: NOW - 5000,
                     barrierHold: { since: NOW - 20 * MIN } };
        assert.strictEqual(stallWindowSince(ix), NOW - 5000);
    });

    it('ignores a rollback stamp left behind once the reason is gone', function(){
        const held = { since: NOW - 3000 };
        assert.strictEqual(stallWindowSince({ stallReason: 'price_sync_barrier', rollbackStartedAt: NOW - 20 * MIN,
                                              barrierHold: held }), NOW - 3000);
        assert.strictEqual(stallWindowSince({ stallReason: null, rollbackStartedAt: NOW - 20 * MIN,
                                              barrierHold: null }), null);
    });

    it('returns the barrier hold start when no rollback is running', function(){
        assert.strictEqual(stallWindowSince({ stallReason: 'price_sync_barrier', rollbackStartedAt: null,
                                              barrierHold: { since: NOW - 3000 } }), NOW - 3000);
        assert.strictEqual(stallWindowSince({ stallReason: 'price_sync_barrier', barrierHold: null }), null);
    });
});

describe('resolveRollbackGraceMs', function(){
    it('is a multiple of the stall grace, never below it', function(){
        assert.strictEqual(resolveRollbackGraceMs(120000), 600000);
        assert.ok(resolveRollbackGraceMs(30000) >= 30000);
    });

    it('leaves an unusable stall grace unchanged', function(){
        assert.strictEqual(resolveRollbackGraceMs(null), null);
        assert.ok(Number.isNaN(resolveRollbackGraceMs(NaN)));
    });
});
