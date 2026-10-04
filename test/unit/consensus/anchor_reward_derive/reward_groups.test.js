/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************/

'use strict';

const assert = require('assert');
const { rewardRoundQualifier } = require('../../../../src/actions/anchor/anchor_reward_key.js');
const { groupByLogicalReward } = require('../../../../src/consensus/anchor_reward_derive/reward_groups.js');

function rewardRow(overrides = {}) {
    return Object.assign({
        reward_type: 'anchor_BTC',
        round_reference: 21,
        snapshot_block: 100,
        publisher: 'publisher-a',
    }, overrides);
}

function registerGroupingTests() {
    it('returns an empty Map for an empty list', function () {
        const groups = groupByLogicalReward([]);

        assert.ok(groups instanceof Map);
        assert.deepStrictEqual(Array.from(groups), []);
    });

    it('keeps rows with one logical reward together in input order', function () {
        const rows = [
            rewardRow({ publisher: 'publisher-c' }),
            rewardRow({ publisher: 'publisher-a' }),
            rewardRow({ publisher: 'publisher-b' }),
        ];
        const qualifier = rewardRoundQualifier('anchor_BTC', 100);
        const groups = groupByLogicalReward(rows);

        assert.deepStrictEqual(Array.from(groups.keys()), [`anchor_BTC|21|${qualifier}`]);
        assert.deepStrictEqual(groups.get(`anchor_BTC|21|${qualifier}`), rows);
    });

    it('separates rows with a different reward type or round reference', function () {
        const rows = [
            rewardRow(),
            rewardRow({ reward_type: 'anchor_LTC' }),
            rewardRow({ round_reference: 22 }),
        ];
        const groups = groupByLogicalReward(rows);

        assert.strictEqual(groups.size, 3);
        assert.deepStrictEqual(Array.from(groups.values()).map(group => group[0]), rows);
    });
}

function registerQualifierAndMutationTests() {
    it('uses snapshot blocks only when the reward qualifier distinguishes them', function () {
        const archiveRows = [
            rewardRow({ reward_type: 'anchor_archive', snapshot_block: 100 }),
            rewardRow({ reward_type: 'anchor_archive', snapshot_block: 101 }),
        ];
        const chainRows = [
            rewardRow({ snapshot_block: 100 }),
            rewardRow({ snapshot_block: 101 }),
        ];

        assert.notStrictEqual(
            rewardRoundQualifier('anchor_archive', 100),
            rewardRoundQualifier('anchor_archive', 101));
        assert.strictEqual(groupByLogicalReward(archiveRows).size, 2);
        assert.strictEqual(rewardRoundQualifier('anchor_BTC', 100), rewardRoundQualifier('anchor_BTC', 101));
        assert.deepStrictEqual(Array.from(groupByLogicalReward(chainRows).values()), [chainRows]);
    });

    it('does not mutate the input list or its rows', function () {
        const rows = [
            Object.freeze(rewardRow()),
            Object.freeze(rewardRow({ publisher: 'publisher-b' })),
        ];
        const frozenRows = Object.freeze(rows);

        const groups = groupByLogicalReward(frozenRows);

        assert.deepStrictEqual(Array.from(groups.values()), [rows]);
        assert.strictEqual(groups.values().next().value[0], rows[0]);
        assert.ok(Object.isFrozen(frozenRows));
        assert.ok(frozenRows.every(Object.isFrozen));
    });
}

describe('groupByLogicalReward', function () {
    registerGroupingTests();
    registerQualifierAndMutationTests();
});
