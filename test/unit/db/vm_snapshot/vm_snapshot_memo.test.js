'use strict';

const assert = require('assert');

const { deepFreeze, memoizedVmSnapshot } = require('../../../../src/db/vm_snapshot_memo.js');

describe('deepFreeze()', function () {
    it('freezes nested objects and arrays', function () {
        const value = { nested: { items: [{ enabled: true }] } };

        assert.strictEqual(deepFreeze(value), value);
        assert.ok(Object.isFrozen(value));
        assert.ok(Object.isFrozen(value.nested));
        assert.ok(Object.isFrozen(value.nested.items));
        assert.ok(Object.isFrozen(value.nested.items[0]));
    });

    it('returns primitives and null unchanged', function () {
        const marker = Symbol('snapshot');

        for(const value of [null, undefined, true, 17, 19n, 'snapshot', marker])
            assert.strictEqual(deepFreeze(value), value);
    });

    it('tolerates an already-frozen value', function () {
        const value = Object.freeze({ ready: true });

        assert.strictEqual(deepFreeze(value), value);
        assert.ok(Object.isFrozen(value));
    });
});

describe('memoizedVmSnapshot()', function () {
    it('builds every time when the memo is not a Map', async function () {
        const db = { _vmSnapshotMemo: {}, blockIndex: 20 };
        let builds = 0;
        const build = async () => ({ build: ++builds });

        const first = await memoizedVmSnapshot(db, 'state', 20, build);
        const second = await memoizedVmSnapshot(db, 'state', 20, build);

        assert.strictEqual(builds, 2);
        assert.notStrictEqual(second, first);
    });

    it('builds every time when the bound is above the block index', async function () {
        const db = { _vmSnapshotMemo: new Map(), blockIndex: '20' };
        let builds = 0;
        const build = async () => ({ build: ++builds });

        await memoizedVmSnapshot(db, 'state', 21, build);
        await memoizedVmSnapshot(db, 'state', 21, build);

        assert.strictEqual(builds, 2);
        assert.strictEqual(db._vmSnapshotMemo.size, 0);
    });

    it('builds once per key and returns the same frozen object', async function () {
        const db = { _vmSnapshotMemo: new Map(), blockIndex: 20 };
        let builds = 0;
        const build = async () => ({ build: ++builds, nested: { values: [1] } });

        const first = await memoizedVmSnapshot(db, 'alpha', 20, build);
        const second = await memoizedVmSnapshot(db, 'alpha', 20, build);

        assert.strictEqual(builds, 1);
        assert.strictEqual(second, first);
        assert.ok(Object.isFrozen(first));
        assert.ok(Object.isFrozen(first.nested));
        assert.ok(Object.isFrozen(first.nested.values));
    });

    it('keeps two keys separate', async function () {
        const db = { _vmSnapshotMemo: new Map(), blockIndex: 20 };
        let builds = 0;
        const build = async () => ({ build: ++builds });

        const alpha = await memoizedVmSnapshot(db, 'alpha', 20, build);
        const beta = await memoizedVmSnapshot(db, 'beta', 20, build);

        assert.strictEqual(builds, 2);
        assert.notStrictEqual(beta, alpha);
        assert.strictEqual(await memoizedVmSnapshot(db, 'alpha', 20, build), alpha);
        assert.strictEqual(await memoizedVmSnapshot(db, 'beta', 20, build), beta);
        assert.strictEqual(builds, 2);
    });
});
