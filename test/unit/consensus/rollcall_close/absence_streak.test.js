'use strict';

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
 *********************************************************************/

const assert = require('assert');
const rca = require('../../../../src/consensus/gates/rollcall_gate.js');
const {
    pinnedSources,
    sourceStreak,
    measureAbsences
} = require('../../../../src/consensus/rollcall_close/absence_streak.js');

function row(epochHeight, sources){
    return {
        epoch_height: epochHeight,
        responsible_set_json: sources === null ? null : JSON.stringify(sources)
    };
}

function stubDb(lookback, absencesBySource){
    return {
        lookbackCalls: [],
        absenceCalls: [],
        inserts: [],
        async getRolledRollcallEpochs(epochHeight, limit){
            this.lookbackCalls.push([epochHeight, limit]);
            return lookback;
        },
        async getRollcallAbsenceEpochsForSource(source, epochHeights){
            this.absenceCalls.push([source, epochHeights]);
            return absencesBySource[source] || [];
        },
        async insertRollcallAbsences(rows){
            this.inserts.push(rows);
            return rows.length;
        }
    };
}

describe('pinnedSources', function () {
    it('returns null when a pinned set cannot be read', function () {
        const cases = [
            undefined,
            {},
            { responsible_set_json: null },
            { responsible_set_json: undefined },
            { responsible_set_json: '{bad json' },
            { responsible_set_json: JSON.stringify({ source: 'alpha' }) }
        ];

        for(const candidate of cases)
            assert.strictEqual(pinnedSources(candidate), null);
    });

    it('returns a Set of string sources for an array', function () {
        const actual = pinnedSources({ responsible_set_json: JSON.stringify(['alpha', 7, null]) });

        assert.ok(actual instanceof Set);
        assert.deepStrictEqual([...actual], ['alpha', '7', 'null']);
    });
});

describe('sourceStreak', function () {
    it('counts the current row and consecutive pinned absences', function () {
        const lookback = [row(30, ['alpha']), row(20, ['alpha'])];

        assert.strictEqual(sourceStreak('alpha', lookback, new Set([20]), 30), 2);
    });

    it('skips epochs where the source was not pinned', function () {
        const lookback = [row(30, ['alpha']), row(20, ['beta']), row(10, ['alpha'])];

        assert.strictEqual(sourceStreak('alpha', lookback, new Set([10]), 30), 2);
    });

    it('stops at a pinned epoch where the source was present', function () {
        const lookback = [row(30, ['alpha']), row(20, ['alpha']), row(10, ['alpha'])];

        assert.strictEqual(sourceStreak('alpha', lookback, new Set([10]), 30), 1);
    });

    it('stops at a row with no readable pinned set', function () {
        const lookback = [row(30, ['alpha']), row(20, null), row(10, ['alpha'])];

        assert.strictEqual(sourceStreak('alpha', lookback, new Set([10]), 30), 1);
    });

    it('never exceeds the eviction threshold', function () {
        const lookback = [30, 20, 10, 0].map((height) => row(height, ['alpha']));
        const priorAbsences = new Set([20, 10, 0]);

        assert.strictEqual(
            sourceStreak('alpha', lookback, priorAbsences, 30),
            rca.ROLLCALL_EVICT_MISSES
        );
    });
});

describe('measureAbsences', function () {
    it('inserts every absence and marks only the eviction streak', async function () {
        const lookback = [row(30, ['alpha', 'beta', 'gamma']), row(20, ['alpha', 'beta', 'gamma'])];
        const db = stubDb(lookback, { alpha: [20] });
        const result = await measureAbsences(
            db, 30, 42, ['alpha', 'beta', 'gamma'], new Set(['gamma'])
        );

        assert.deepStrictEqual(result, { absentSources: ['alpha', 'beta'], evictedSources: ['alpha'] });
        assert.deepStrictEqual(db.lookbackCalls, [[30, rca.ROLLCALL_STREAK_LOOKBACK]]);
        assert.deepStrictEqual(db.absenceCalls, [
            ['alpha', [30, 20]],
            ['beta', [30, 20]]
        ]);
        assert.deepStrictEqual(db.inserts, [[
            { epoch_height: 30, source: 'alpha', close_block: 42, evicted: true },
            { epoch_height: 30, source: 'beta', close_block: 42, evicted: false }
        ]]);
    });

    it('does not insert when every pinned source is present', async function () {
        const db = stubDb([row(30, ['alpha', 'beta'])], {});
        const result = await measureAbsences(
            db, 30, 42, ['alpha', 'beta'], new Set(['alpha', 'beta'])
        );

        assert.deepStrictEqual(result, { absentSources: [], evictedSources: [] });
        assert.deepStrictEqual(db.absenceCalls, []);
        assert.deepStrictEqual(db.inserts, []);
    });
});
