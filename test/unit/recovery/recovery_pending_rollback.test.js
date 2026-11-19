'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert');
const Database = require('../../../src/db');
const ar = require('../../../src/consensus/gates/anchor_reward_gate.js');
const { initIndexIdState, initReadMemos, initTransactionState } =
    require('../../../src/db/database/instance_state.js');

const EARN = 800000;
const DUE_BLOCK = EARN + ar.ANCHOR_REWARD_MIRROR_MATURITY;
const COUNT_SQL = /SELECT COUNT\(\*\) AS c FROM recovery_pending_rewards/;

// The statements the recovery apply path issues, answered from one staged row. Anything
// else returns [] so an unexpected statement surfaces as a failed count, not a pass.
function answer(store, sql, params) {
    if (COUNT_SQL.test(sql)) {
        store.probes++;
        return [{ c: store.staged.filter(r => r.applied === 0).length }];
    }
    if (/JOIN index_addresses ia ON ia\.address = rpr\.source_address/.test(sql)) {
        return store.staged.filter(r => r.applied === 0 && r.block_index <= Number(params[0]))
            .slice(0, 1).map(r => ({ source_address: r.source_address, source_id: 5 }));
    }
    if (/WHERE source_address=\? AND applied=0/.test(sql))
        return store.staged.filter(r => r.applied === 0 && r.source_address === params[0]);
    if (/INSERT IGNORE INTO validator_rewards/.test(sql)) {
        store.rewards.push(params[6]);
        return { affectedRows: 1 };
    }
    if (/UPDATE recovery_pending_rewards SET applied=1/.test(sql)) {
        const row = store.staged.find(r => r.id === params[2]);
        if (row) row.applied = 1;
        return { affectedRows: row ? 1 : 0 };
    }
    return [];
}

// A connection whose ROLLBACK really restores the staged rows and rewards, and which a
// test can make fail at commit or release.
function makeConnection(store, faults) {
    let snapshot = null;
    const savepoints = new Map();
    const capture = () => ({ staged: store.staged.map(r => Object.assign({}, r)), rewards: store.rewards.slice() });
    const apply = (state) => {
        store.staged = state.staged.map(r => Object.assign({}, r));
        store.rewards = state.rewards.slice();
    };
    const restore = () => {
        if (!snapshot) return;
        apply(snapshot);
        snapshot = null;
    };
    return {
        async beginTransaction() { snapshot = capture(); },
        async query(sql, params) {
            const named = /^(ROLLBACK TO SAVEPOINT|SAVEPOINT) (\w+)$/.exec(sql);
            if (named && named[1] === 'SAVEPOINT') savepoints.set(named[2], capture());
            if (named && named[1] !== 'SAVEPOINT') apply(savepoints.get(named[2]));
            return named ? [] : answer(store, sql, params);
        },
        async commit() {
            if (faults.commit) throw new Error('commit failed');
            snapshot = null;
        },
        async rollback() { restore(); },
        async release() {
            restore();
            if (faults.release) throw new Error('release failed');
        }
    };
}

// A real Database instance (every prototype method, the constructor's own state), with
// only the pool and the pubkey interning replaced.
function makeIndexerDb(faults = {}) {
    const store = { probes: 0, rewards: [], staged: [{
        id: 1, source_address: 'bc1qAlice', validator_pubkey: 'ab'.repeat(32), reward_type: 'anchor_BTC',
        round_reference: 42, amount: '10.00000000', block_index: EARN, applied: 0
    }] };
    const db = Object.create(Database.prototype);
    db.config = { NETWORK: 'regtest', COIN: 'BTC' };
    db.util = {
        isNull: v => v === null || v === undefined,
        throwError: message => { throw new Error(message); },
        logError: () => {}
    };
    db.transactionConnection = null;
    initIndexIdState(db);
    initReadMemos(db);
    initTransactionState(db);
    db.pool = { getConnection: async () => makeConnection(store, faults) };
    db.getOrCreatePubkeyId = async () => 9;
    return { db, store };
}

async function materializeInTransaction(db) {
    await db.beginTransaction();
    assert.strictEqual(await db.applyPendingRewardsDueAtBlock(DUE_BLOCK), 1);
    assert.strictEqual(db._recoveryPendingRemaining, 0);
}

describe('recovery pending probe follows transaction outcome @regression @tier1', function () {
    it('invalidates the speculative count after rollback', async function () {
        const { db, store } = makeIndexerDb();
        await materializeInTransaction(db);
        await db.rollbackTransaction();
        assert.strictEqual(store.staged[0].applied, 0);
        await db.beginTransaction();
        assert.strictEqual(await db.applyPendingRewardsDueAtBlock(DUE_BLOCK), 1);
        await db.commitTransaction();
        assert.deepStrictEqual(store.rewards, [EARN]);
        assert.strictEqual(store.probes, 2);
    });

    it('invalidates the speculative count after a failed commit', async function () {
        const faults = { commit: true };
        const { db, store } = makeIndexerDb(faults);
        await materializeInTransaction(db);
        await assert.rejects(() => db.commitTransaction(), /commitTransaction error/);
        assert.strictEqual(store.staged[0].applied, 0);
        faults.commit = false;
        await db.beginTransaction();
        assert.strictEqual(await db.applyPendingRewardsDueAtBlock(DUE_BLOCK), 1);
        assert.strictEqual(await db.commitTransaction(), true);
        assert.deepStrictEqual(store.rewards, [EARN]);
    });

    it('keeps the committed count after a successful commit', async function () {
        const { db, store } = makeIndexerDb();
        await materializeInTransaction(db);
        assert.strictEqual(await db.commitTransaction(), true);
        await db.beginTransaction();
        assert.strictEqual(await db.applyPendingRewardsDueAtBlock(DUE_BLOCK + 1), 0);
        await db.commitTransaction();
        assert.strictEqual(store.probes, 1);
        assert.deepStrictEqual(store.rewards, [EARN]);
    });

    it('re-counts after a rollback whose connection release throws', async function () {
        const faults = { release: true };
        const { db, store } = makeIndexerDb(faults);
        await materializeInTransaction(db);
        await assert.rejects(() => db.rollbackTransaction(), /release failed/);
        assert.strictEqual(store.staged[0].applied, 0);
        assert.strictEqual(db._recoveryPendingChecked, false);
        assert.strictEqual(await db.probeRecoveryPending(), true);
        assert.strictEqual(store.probes, 2);
    });

    it('re-counts after beginTransaction abandons an uncommitted connection', async function () {
        const { db, store } = makeIndexerDb();
        await materializeInTransaction(db);
        // The block flow lost its transaction without a rollback; the next begin drops it
        // and the released connection's open transaction is rolled back by the server.
        db.releaseTxLock();
        await db.beginTransaction();
        assert.strictEqual(store.staged[0].applied, 0);
        assert.strictEqual(await db.applyPendingRewardsDueAtBlock(DUE_BLOCK), 1);
        assert.strictEqual(await db.commitTransaction(), true);
        assert.deepStrictEqual(store.rewards, [EARN]);
    });

    it('re-counts after a savepoint rollback inside a committing transaction', async function () {
        const { db, store } = makeIndexerDb();
        await db.beginTransaction();
        const savepoint = await db.createSavepoint('vm_execute_7');
        assert.strictEqual(await db.applyPendingRewardsDueAtBlock(DUE_BLOCK), 1);
        await db.rollbackToSavepoint(savepoint);
        assert.strictEqual(store.staged[0].applied, 0);
        assert.strictEqual(await db.applyPendingRewardsDueAtBlock(DUE_BLOCK), 1);
        assert.strictEqual(await db.commitTransaction(), true);
        assert.deepStrictEqual(store.rewards, [EARN]);
    });

    it('re-counts after a failed commit whose connection release throws', async function () {
        const { db, store } = makeIndexerDb({ commit: true, release: true });
        await materializeInTransaction(db);
        await assert.rejects(() => db.commitTransaction(), /release failed/);
        assert.strictEqual(store.staged[0].applied, 0);
        assert.strictEqual(await db.probeRecoveryPending(), true);
        assert.strictEqual(store.probes, 2);
    });

    it('re-counts when beginTransaction fails to release an abandoned connection', async function () {
        const faults = {};
        const { db, store } = makeIndexerDb(faults);
        await materializeInTransaction(db);
        faults.release = true;
        db.releaseTxLock();
        await assert.rejects(() => db.beginTransaction(), /release failed/);
        assert.strictEqual(store.staged[0].applied, 0);
        assert.strictEqual(await db.probeRecoveryPending(), true);
        assert.strictEqual(store.probes, 2);
    });
});
