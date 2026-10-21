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
 * test/unit/db/vm_snapshot/cross_block_snapshot_cache.test.js
 *
 * A VM snapshot built for a bound is served again in later blocks until a rollback
 * rewrites rows below that bound; invalidate(fromBlock) drops the affected entries.
 */

'use strict';

const assert = require('assert');

const { memoizedVmSnapshot, invalidate } = require('../../../../src/db/vm_snapshot_memo.js');

// One block pass: a fresh per-block memo over the db's long-lived cache.
function pass(db, blockIndex){
    db.blockIndex = blockIndex;
    db._vmSnapshotMemo = new Map();
}

function counter(){
    let builds = 0;
    const build = async () => ({ build: ++builds });
    build.count = () => builds;
    return build;
}

describe('VM snapshot cross-block cache @regression @tier1', function () {
    it('serves the same snapshot to a later block without rebuilding', async function () {
        const db = {};
        const build = counter();
        pass(db, 20);
        const first = await memoizedVmSnapshot(db, 'crossChain:15', 15, build);
        pass(db, 21);
        const second = await memoizedVmSnapshot(db, 'crossChain:15', 15, build);
        assert.strictEqual(build.count(), 1);
        assert.strictEqual(second, first);
    });

    it('does not serve a cached snapshot outside a block pass', async function () {
        const db = { blockIndex: 20 };
        const build = counter();
        pass(db, 20);
        await memoizedVmSnapshot(db, 'k', 20, build);
        db._vmSnapshotMemo = null;
        await memoizedVmSnapshot(db, 'k', 20, build);
        assert.strictEqual(build.count(), 2);
    });

    it('invalidate(fromBlock) drops only snapshots whose bound is above fromBlock', async function () {
        const db = {};
        const build = counter();
        pass(db, 30);
        await memoizedVmSnapshot(db, 'low', 10, build);
        await memoizedVmSnapshot(db, 'edge', 20, build);
        await memoizedVmSnapshot(db, 'high', 25, build);
        assert.strictEqual(invalidate(db, 20), 1);
        pass(db, 31);
        await memoizedVmSnapshot(db, 'low', 10, build);
        await memoizedVmSnapshot(db, 'edge', 20, build);
        assert.strictEqual(build.count(), 3);
        await memoizedVmSnapshot(db, 'high', 25, build);
        assert.strictEqual(build.count(), 4);
    });

    it('invalidate() on a db that never cached anything is a no-op', function () {
        assert.strictEqual(invalidate({}, 5), 0);
    });

    it('rebuilds after a rollback and re-apply of the same blocks', async function () {
        const db = {};
        let version = 0;
        const build = async () => ({ version: ++version });
        pass(db, 20);
        const before = await memoizedVmSnapshot(db, 'k', 20, build);
        invalidate(db, 18);
        pass(db, 19);
        pass(db, 20);
        const after = await memoizedVmSnapshot(db, 'k', 20, build);
        assert.notStrictEqual(after, before);
        assert.strictEqual(after.version, 2);
    });

    it('flushes on a dropped invalidation when the block index goes backwards', async function () {
        const db = {};
        const build = counter();
        pass(db, 20);
        await memoizedVmSnapshot(db, 'k', 15, build);
        pass(db, 21);
        await memoizedVmSnapshot(db, 'k', 15, build);
        assert.strictEqual(build.count(), 1);
        // rollback to 17 with no invalidate() call
        pass(db, 17);
        await memoizedVmSnapshot(db, 'k', 15, build);
        assert.strictEqual(build.count(), 2);
    });

    it('bounds the cache size', async function () {
        const db = {};
        const build = counter();
        pass(db, 1000);
        for(let i = 0; i < 100; i++)
            await memoizedVmSnapshot(db, 'k' + i, i, build);
        assert.ok(db._vmSnapshotCache.entries.size <= 64);
    });
});
