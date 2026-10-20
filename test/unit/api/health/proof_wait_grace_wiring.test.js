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
 * Unit: the roll-call and capability proof waits are judged against their own
 * proofWaitGraceMs, which sits above the barrier hold ceiling, and BOTH production
 * callers (/status and the health advance fields) pass that field from the indexer.
 */

'use strict';

const assert = require('assert');
const { stallClassOf, stallWedged } = require('../../../../src/XChainIndexer/stall_health.js');
const { advanceFields } = require('../../../../src/api/health/advance_fields.js');
const { statusVerdict } = require('../../../../src/api/status_route.js');
const XChainIndexer = require('../../../../src/XChainIndexer');

const NOW = 100000000;
const GRACE = 120000;
const CEILING = 900000;
const PROOF_GRACE = 1800000;
const PROOF_REASONS = ['rollcall_proof_unavailable', 'capability_proof_unavailable'];

// An indexer held on `reason` with its last commit `ageMs` ago and no hold record.
function fakeIndexer(ageMs, reason){
    return {
        stallReason: reason, stallClearsAt: null, lastBlockCommittedAt: NOW - ageMs,
        healthStallGraceMs: GRACE, priceLandingGraceMs: 2 * GRACE, proofWaitGraceMs: PROOF_GRACE,
        barrierHold: null, barrierHoldCeilingMs: CEILING,
        isPollSilent: () => false, lastPollAt: NOW, isSynced: () => false
    };
}

describe('proof wait grace wiring @regression', function () {
    it('keeps a proof wait off the wedge inside its own grace', function () {
        for (const reason of PROOF_REASONS) {
            assert.strictEqual(stallWedged(reason, NOW - 600000, GRACE, NOW, null, null, null, PROOF_GRACE), false, reason);
            assert.strictEqual(stallClassOf(reason, NOW - 600000, GRACE, NOW, null, null, null, PROOF_GRACE),
                'barrier_defer', reason);
        }
    });

    it('wedges a proof wait only past proofWaitGraceMs', function () {
        for (const reason of PROOF_REASONS) {
            assert.strictEqual(stallWedged(reason, NOW - PROOF_GRACE, GRACE, NOW, null, null, null, PROOF_GRACE), false, reason);
            assert.strictEqual(stallWedged(reason, NOW - PROOF_GRACE - 1, GRACE, NOW, null, null, null, PROOF_GRACE), true, reason);
        }
    });

    it('leaves other reasons, and a proof wait with no usable proof grace, on the generic grace', function () {
        assert.strictEqual(stallWedged('price_sync_barrier', NOW - 600000, GRACE, NOW, null, null, null, PROOF_GRACE), true);
        assert.strictEqual(stallWedged('vm_executor_unavailable', NOW - 600000, GRACE, NOW, null, null, null, PROOF_GRACE), true);
        for (const unusable of [undefined, null, 0, -1, NaN])
            assert.strictEqual(stallWedged('rollcall_proof_unavailable', NOW - 600000, GRACE, NOW, null, null, null, unusable),
                true, String(unusable));
    });

    it('advanceFields passes proofWaitGraceMs', function () {
        for (const reason of PROOF_REASONS) {
            const f = advanceFields(fakeIndexer(600000, reason), NOW);
            assert.match(f.stallClass, /_proof_wait$/, reason);
            assert.strictEqual(f.degraded, true, reason);
            assert.strictEqual(advanceFields(fakeIndexer(PROOF_GRACE + 1, reason), NOW).stallClass, 'wedged', reason);
        }
    });

    it('/status verdict passes proofWaitGraceMs', function () {
        const realNow = Date.now;
        Date.now = () => NOW;
        try {
            for (const reason of PROOF_REASONS) {
                const v = statusVerdict(XChainIndexer, fakeIndexer(600000, reason));
                assert.strictEqual(v.stallClass, 'barrier_defer', reason);
                assert.strictEqual(v.wedged, false, reason);
                assert.strictEqual(statusVerdict(XChainIndexer, fakeIndexer(PROOF_GRACE + 1, reason)).wedged, true, reason);
            }
        } finally { Date.now = realNow; }
    });

    it('derives the proof grace from the hold ceiling, never below the stall grace', function () {
        const ix = new XChainIndexer();
        assert.strictEqual(ix.proofWaitGraceMs, Math.max(2 * ix.barrierHoldCeilingMs, ix.healthStallGraceMs));
        assert.ok(ix.barrierHoldCeilingMs <= 0 || ix.proofWaitGraceMs > ix.barrierHoldCeilingMs,
            'the wedge must come after the _stuck class the ceiling publishes');
    });
});
