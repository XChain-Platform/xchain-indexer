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
 * Branch and precedence coverage for the pure retroactive boot plan.
 *
 *********************************************************************/

'use strict';

const assert = require('assert');
const { planRetroactiveBoot } = require('../../../../src/consensus/retroactive/boot_plan');

function plan(overrides = {}){
    return planRetroactiveBoot({
        openMarker: null,
        refusedKeys: [],
        target: 91,
        tip: 100,
        capBlocks: 10,
        goMatches: false,
        mirrorGap: null,
        ...overrides
    });
}

describe('retroactive boot plan @regression @tier1', function () {
    it('returns resume for each open marker state without recomputing moves', function () {
        for(const state of ['pending', 'replaying']){
            assert.deepStrictEqual(plan({
                openMarker: { state, target: 50 },
                refusedKeys: ['account.balance'],
                target: 101,
                tip: -1,
                capBlocks: 1.5,
                mirrorGap: 'price horizon'
            }), {
                action: 'resume',
                target: 50,
                stallReason: 'retroactive_replay'
            });
        }
    });

    it('returns refuse non_movable with sorted keys and leaves the input unchanged', function () {
        const refusedKeys = ['z.balance', 'a.owner', 'm.status'];

        assert.deepStrictEqual(plan({ refusedKeys, target: 1, mirrorGap: 'price horizon' }), {
            action: 'refuse',
            reason: 'non_movable',
            keys: ['a.owner', 'm.status', 'z.balance']
        });
        assert.deepStrictEqual(refusedKeys, ['z.balance', 'a.owner', 'm.status']);
    });

    it('returns serve when no retroactive target exists', function () {
        assert.deepStrictEqual(plan({ target: null }), { action: 'serve' });
    });

    it('returns refuse needs_go when replay distance exceeds the cap', function () {
        assert.deepStrictEqual(plan({ target: 90 }), {
            action: 'refuse',
            reason: 'needs_go',
            stallReason: 'retroactive_replay_needs_go',
            target: 90,
            distance: 11
        });
    });

    it('returns rollback past the cap when the go matches', function () {
        assert.deepStrictEqual(plan({ target: 90, goMatches: true }), {
            action: 'rollback',
            target: 90,
            distance: 11,
            stallReason: 'retroactive_replay'
        });
    });

    it('returns refuse mirror_gap with its detail', function () {
        assert.deepStrictEqual(plan({ mirrorGap: 'price horizon' }), {
            action: 'refuse',
            reason: 'mirror_gap',
            detail: 'price horizon'
        });
    });

    it('orders non-movable, cap and go, and mirror refusal causes', function () {
        assert.strictEqual(plan({
            refusedKeys: ['account.balance'],
            target: 1,
            mirrorGap: 'price horizon'
        }).reason, 'non_movable');

        assert.strictEqual(plan({
            target: 90,
            mirrorGap: 'price horizon'
        }).reason, 'needs_go');
    });

    it('returns rollback when replay distance is exactly at the cap', function () {
        assert.deepStrictEqual(plan(), {
            action: 'rollback',
            target: 91,
            distance: 10,
            stallReason: 'retroactive_replay'
        });
    });

    it('throws for every invalid numeric input', function () {
        for(const name of ['tip', 'capBlocks']){
            for(const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1'])
                assert.throws(() => plan({ [name]: value }), TypeError);
        }

        for(const target of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1'])
            assert.throws(() => plan({ target }), TypeError);

        assert.throws(() => plan({ target: 101 }), RangeError);
    });
});
