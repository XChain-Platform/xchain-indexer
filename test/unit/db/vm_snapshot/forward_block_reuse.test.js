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
 * test/unit/db/vm_snapshot/forward_block_reuse.test.js
 */

'use strict';

const assert = require('assert');
const blocks = require('../../../../src/db/blocks/index.js');

function makeDb(state){
    const db = Object.assign({}, blocks, {
        builds: 0,
        async buildCrossChainDataForVM(bound){
            this.builds++;
            return { attestations: {}, settled: {}, calls: {}, bound };
        },
        async doQuery(sql){
            if(String(sql).includes('cross_chain_settlements')) return state.settlements ? [{ 1: 1 }] : [];
            if(String(sql).includes('xcalls')) return state.calls ? [{ 1: 1 }] : [];
            throw new Error('unexpected query: ' + sql);
        }
    });
    return db;
}

function beginPass(db, blockIndex){
    db.blockIndex = blockIndex;
    db._vmSnapshotMemo = new Map();
}

describe('cross-chain VM snapshot forward block reuse @regression @tier1', function () {
    it('serves the next block from the cached snapshot without a build', async function () {
        const db = makeDb({});
        beginPass(db, 10);
        const first = await db.getCrossChainDataForVM(10);
        beginPass(db, 11);
        const second = await db.getCrossChainDataForVM(11);
        beginPass(db, 12);
        const third = await db.getCrossChainDataForVM(12);
        assert.strictEqual(db.builds, 1);
        assert.strictEqual(second, first);
        assert.strictEqual(third, first);
    });

    it('rebuilds when a settlement landed between the bounds', async function () {
        const db = makeDb({ settlements: true });
        beginPass(db, 10);
        await db.getCrossChainDataForVM(10);
        beginPass(db, 11);
        const next = await db.getCrossChainDataForVM(11);
        assert.strictEqual(db.builds, 2);
        assert.strictEqual(next.bound, 11);
    });

    it('rebuilds when a call resolved between the bounds', async function () {
        const db = makeDb({ calls: true });
        beginPass(db, 10);
        await db.getCrossChainDataForVM(10);
        beginPass(db, 11);
        await db.getCrossChainDataForVM(11);
        assert.strictEqual(db.builds, 2);
    });

    it('builds fresh outside a block pass', async function () {
        const db = makeDb({});
        await db.getCrossChainDataForVM(10);
        await db.getCrossChainDataForVM(11);
        assert.strictEqual(db.builds, 2);
    });

    it('does not reuse a pre-rollback snapshot when the tip went back without invalidate()', async function () {
        const db = makeDb({});
        beginPass(db, 10);
        const stale = await db.getCrossChainDataForVM(10);
        beginPass(db, 12);
        await db.getCrossChainDataForVM(12);
        assert.strictEqual(db.builds, 1);
        // rollback to 8, then re-apply 9 and 10 with different rows; nobody called invalidate()
        beginPass(db, 9);
        const afterRollback = await db.getCrossChainDataForVM(9);
        assert.strictEqual(db.builds, 2);
        assert.notStrictEqual(afterRollback, stale);
        beginPass(db, 10);
        const replayed = await db.getCrossChainDataForVM(10);
        assert.notStrictEqual(replayed, stale);
        assert.strictEqual(replayed, afterRollback);
        assert.strictEqual(db.builds, 2);
    });

    it('does not reuse a snapshot invalidated by an explicit rollback', async function () {
        const { invalidate } = require('../../../../src/db/vm_snapshot_memo.js');
        const db = makeDb({});
        beginPass(db, 10);
        const stale = await db.getCrossChainDataForVM(10);
        invalidate(db, 9);
        beginPass(db, 10);
        const fresh = await db.getCrossChainDataForVM(10);
        assert.notStrictEqual(fresh, stale);
        assert.strictEqual(db.builds, 2);
    });
});
