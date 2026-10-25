/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * Unit coverage for the pure retroactive mirror coverage judgment.
 *
 *********************************************************************/

'use strict';

const assert = require('assert');
const {
    PRICE_HORIZON_SLOP_SECONDS,
    requiredPriceFloor,
    mirrorCoverageGap,
} = require('../../../../src/consensus/retroactive/mirror_coverage.js');
const { planRetroactiveBoot } = require('../../../../src/consensus/retroactive/boot_plan.js');

const TARGET_BLOCK_TIME = 1000000;
const FIAT_WINDOW_SECONDS = 3600;
const PRICE_FLOOR = TARGET_BLOCK_TIME - (2 * FIAT_WINDOW_SECONDS) -
    PRICE_HORIZON_SLOP_SECONDS;

function gap(overrides = {}){
    return mirrorCoverageGap({
        targetBlockTime: TARGET_BLOCK_TIME,
        fiatWindowSeconds: FIAT_WINDOW_SECONDS,
        oldestPriceRoundTime: PRICE_FLOOR,
        requiredCapabilityBlock: null,
        ...overrides
    });
}

function plan(mirrorGap){
    return planRetroactiveBoot({
        openMarker: null,
        refusedKeys: [],
        target: 90,
        tip: 100,
        capBlocks: 432,
        goMatches: false,
        mirrorGap
    });
}

describe('retroactive mirror coverage @regression @tier1', function () {
    it('computes the required price floor with two windows and one day of slop', function () {
        assert.strictEqual(PRICE_HORIZON_SLOP_SECONDS, 86400);
        assert.strictEqual(
            requiredPriceFloor(TARGET_BLOCK_TIME, FIAT_WINDOW_SECONDS),
            PRICE_FLOOR
        );
    });

    it('covers the price floor and refuses a round one second above it', function () {
        assert.strictEqual(gap(), null);
        assert.strictEqual(
            gap({ oldestPriceRoundTime: PRICE_FLOOR + 1 }),
            `price_mirror_horizon:${PRICE_FLOOR + 1}>${PRICE_FLOOR}`
        );
    });

    it('reports an empty price mirror for null and absent readings', function () {
        assert.strictEqual(gap({ oldestPriceRoundTime: null }), 'price_mirror_empty');
        assert.strictEqual(mirrorCoverageGap({
            targetBlockTime: TARGET_BLOCK_TIME,
            fiatWindowSeconds: FIAT_WINDOW_SECONDS
        }), 'price_mirror_empty');
    });

    it('skips capability coverage for a null or absent required block', function () {
        assert.strictEqual(gap({
            requiredCapabilityBlock: null,
            oldestCapabilitySnapshotBlock: 999
        }), null);
        assert.strictEqual(mirrorCoverageGap({
            targetBlockTime: TARGET_BLOCK_TIME,
            fiatWindowSeconds: FIAT_WINDOW_SECONDS,
            oldestPriceRoundTime: PRICE_FLOOR,
            oldestCapabilitySnapshotBlock: 999
        }), null);
    });

    it('covers the required capability block and refuses the next block', function () {
        assert.strictEqual(gap({
            requiredCapabilityBlock: 500,
            oldestCapabilitySnapshotBlock: 500
        }), null);
        assert.strictEqual(gap({
            requiredCapabilityBlock: 500,
            oldestCapabilitySnapshotBlock: 501
        }), 'capability_snapshot_horizon:501>500');
    });

    it('reports an empty capability mirror for null and absent readings', function () {
        assert.strictEqual(gap({
            requiredCapabilityBlock: 500,
            oldestCapabilitySnapshotBlock: null
        }), 'capability_snapshots_empty');
        assert.strictEqual(gap({ requiredCapabilityBlock: 500 }),
            'capability_snapshots_empty');
    });

    it('reports the price gap first when both mirrors have gaps', function () {
        assert.strictEqual(gap({
            oldestPriceRoundTime: PRICE_FLOOR + 1,
            requiredCapabilityBlock: 500,
            oldestCapabilitySnapshotBlock: 501
        }), `price_mirror_horizon:${PRICE_FLOOR + 1}>${PRICE_FLOOR}`);
    });

    it('compares numeric string readings as numbers', function () {
        assert.strictEqual(gap({
            oldestPriceRoundTime: String(PRICE_FLOOR),
            requiredCapabilityBlock: '500',
            oldestCapabilitySnapshotBlock: '500'
        }), null);
        assert.strictEqual(gap({
            oldestPriceRoundTime: String(PRICE_FLOOR),
            requiredCapabilityBlock: '500',
            oldestCapabilitySnapshotBlock: '501'
        }), 'capability_snapshot_horizon:501>500');
    });

    it('throws for every invalid floor input and non-finite mirror reading', function () {
        for(const targetBlockTime of [0, -1, NaN, Infinity, '1000000'])
            assert.throws(() => requiredPriceFloor(targetBlockTime, FIAT_WINDOW_SECONDS), TypeError);

        for(const fiatWindowSeconds of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '3600'])
            assert.throws(() => requiredPriceFloor(TARGET_BLOCK_TIME, fiatWindowSeconds), TypeError);

        for(const oldestPriceRoundTime of [NaN, Infinity, 'not-a-number'])
            assert.throws(() => gap({ oldestPriceRoundTime }), TypeError);

        for(const oldestCapabilitySnapshotBlock of [NaN, Infinity, 'not-a-number']){
            assert.throws(() => gap({
                requiredCapabilityBlock: 500,
                oldestCapabilitySnapshotBlock
            }), TypeError);
        }

        assert.throws(() => gap({
            requiredCapabilityBlock: 'not-a-number',
            oldestCapabilitySnapshotBlock: 500
        }), TypeError);
    });

    it('feeds planRetroactiveBoot an opaque mirror_gap or a covered null', function () {
        const uncovered = gap({ oldestPriceRoundTime: PRICE_FLOOR + 1 });
        assert.deepStrictEqual(plan(uncovered), {
            action: 'refuse',
            reason: 'mirror_gap',
            detail: uncovered
        });
        assert.deepStrictEqual(plan(gap()), {
            action: 'rollback',
            target: 90,
            distance: 11,
            stallReason: 'retroactive_replay'
        });
    });
});
