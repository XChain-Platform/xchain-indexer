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
 **********************************************************************/

'use strict';

const assert = require('assert');
const polls = require('../../../../src/db/polls/vm_snapshot.js');

function makeDb(state={}){
    return Object.assign({}, polls, {
        builds: 0,
        async buildPollResultsForVM(bound, includeTick){
            this.builds++;
            return { polls: {}, bound, includeTick };
        },
        async doQuery(sql){
            if(String(sql).includes('resolved_block')) return state.resolved ? [{ 1: 1 }] : [];
            throw new Error('unexpected query: ' + sql);
        }
    });
}

function beginPass(db, blockIndex){
    db.blockIndex = blockIndex;
    db._vmSnapshotMemo = new Map();
}

describe('poll VM snapshot forward block reuse @regression @tier1', function () {
    it('serves forward blocks from one cached snapshot when no poll resolved', async function () {
        const db = makeDb();
        beginPass(db, 10);
        const first = await db.getPollResultsForVM(10);
        beginPass(db, 11);
        const second = await db.getPollResultsForVM(11);
        beginPass(db, 12);
        const third = await db.getPollResultsForVM(12);
        assert.strictEqual(db.builds, 1);
        assert.strictEqual(second, first);
        assert.strictEqual(third, first);
    });

    it('rebuilds when a poll resolved between snapshot bounds', async function () {
        const db = makeDb({ resolved: true });
        beginPass(db, 10);
        await db.getPollResultsForVM(10);
        beginPass(db, 11);
        const next = await db.getPollResultsForVM(11);
        assert.strictEqual(db.builds, 2);
        assert.strictEqual(next.bound, 11);
    });

    it('never reuses across the tick-visible entry-shape gate', async function () {
        const db = makeDb();
        beginPass(db, 10);
        await db.getPollResultsForVM(10, false);
        beginPass(db, 11);
        const tick = await db.getPollResultsForVM(11, true);
        assert.strictEqual(db.builds, 2);
        assert.strictEqual(tick.includeTick, true);
    });

    it('builds fresh outside a block pass', async function () {
        const db = makeDb();
        await db.getPollResultsForVM(10);
        await db.getPollResultsForVM(11);
        assert.strictEqual(db.builds, 2);
    });

    it('drops cached snapshots when the tip moves backwards', async function () {
        const db = makeDb();
        beginPass(db, 10);
        const stale = await db.getPollResultsForVM(10);
        beginPass(db, 12);
        await db.getPollResultsForVM(12);
        beginPass(db, 9);
        const replayed = await db.getPollResultsForVM(9);
        assert.strictEqual(db.builds, 2);
        assert.notStrictEqual(replayed, stale);
    });

    it('does not reuse a snapshot invalidated by rollback', async function () {
        const { invalidate } = require('../../../../src/db/vm_snapshot_memo.js');
        const db = makeDb();
        beginPass(db, 10);
        const stale = await db.getPollResultsForVM(10);
        invalidate(db, 9);
        beginPass(db, 10);
        const fresh = await db.getPollResultsForVM(10);
        assert.strictEqual(db.builds, 2);
        assert.notStrictEqual(fresh, stale);
    });
});
