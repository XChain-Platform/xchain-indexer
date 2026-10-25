/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC, https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available; contact
 * legal@dankest.llc.
 *
 **********************************************************************
 *
 * Boundary coverage for retroactive witness boot phase planning.
 *
 *********************************************************************/

'use strict';

const assert = require('assert');
const {
    planWitnessPhase,
} = require('../../../../../src/consensus/retroactive/witness_phase_plan.js');

describe('retroactive witness phase plan @regression @tier1', function () {
    it('restarts witness work with an overlay and rollback at the target', function () {
        assert.deepStrictEqual(planWitnessPhase({
            phase: 'witness', tip: 100, target: 100,
        }), {
            rollback: true,
            overlay: true,
            writePhase: null,
            stallReason: null,
        });
        assert.deepStrictEqual(planWitnessPhase({
            phase: 'witness', tip: 120, target: 100,
        }), {
            rollback: true,
            overlay: true,
            writePhase: null,
            stallReason: null,
        });
    });

    it('starts witness work without rollback before the target or without a tip', function () {
        for(const tip of [99, null, undefined]){
            assert.deepStrictEqual(planWitnessPhase({
                phase: 'witness', tip, target: 100,
            }), {
                rollback: false,
                overlay: true,
                writePhase: null,
                stallReason: null,
            });
        }
    });

    it('finalizes a witnessed marker and rolls back only at or beyond the target', function () {
        for(const [tip, rollback] of [[99, false], [null, false], [100, true], [120, true]]){
            assert.deepStrictEqual(planWitnessPhase({
                phase: 'witnessed', tip, target: 100,
            }), {
                rollback,
                overlay: false,
                writePhase: 'final',
                stallReason: null,
            });
        }
    });

    it('does no work for final or absent phases', function () {
        for(const phase of ['final', null, undefined]){
            assert.deepStrictEqual(planWitnessPhase({ phase, tip: 120, target: 100 }), {
                rollback: false,
                overlay: false,
                writePhase: null,
                stallReason: null,
            });
        }
    });

    it('stalls a diverged marker without mutating replay state', function () {
        assert.deepStrictEqual(planWitnessPhase({
            phase: 'diverged', tip: 120, target: 100,
        }), {
            rollback: false,
            overlay: false,
            writePhase: null,
            stallReason: 'retroactive_replay_diverged',
        });
    });

    it('rejects values outside the witness phase vocabulary', function () {
        for(const phase of ['bogus', '', false, 0, {}])
            assert.throws(() => planWitnessPhase({ phase, tip: 1, target: 1 }),
                /invalid retroactive replay witness phase/);
    });

    it('rejects targets that are not non-negative safe integers', function () {
        for(const target of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null])
            assert.throws(() => planWitnessPhase({ phase: 'witness', tip: 1, target }),
                /target must be a non-negative safe integer/);
    });
});
