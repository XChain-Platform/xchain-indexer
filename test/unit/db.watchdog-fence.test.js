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
 * test/unit/db.watchdog-fence.test.js
 *
 * Watchdog-timeout transaction fence (M-16).
 *
 * The block loop wraps each block in util.withTimeout(blockProcessing, ...). On a
 * timeout the outer catch rolls back and moves on, but the abandoned block promise
 * stays pending and can resume later and try to write on the SHARED
 * transactionConnection, which by then belongs to a LATER block's transaction. That
 * would let a zombie block's writes land inside a different transaction's scope.
 *
 * The fix fences writes to the transaction epoch they were issued under: the block loop
 * runs block processing inside db.runInTxEpoch(currentTxEpoch()), every teardown
 * (commit/rollback) bumps the epoch, and doQuery/doQueryStrict/savepoint calls reject if
 * their stored epoch no longer matches the current one. This pins:
 *   1. epoch bumps on begin/commit/rollback (monotonic, unique per transaction);
 *   2. a write inside the matching epoch succeeds (non-timeout path unaffected);
 *   3. a caller with NO epoch context (federation RPC read) is never fenced;
 *   4. a zombie continuation writing after rollback is rejected before it hits the driver,
 *      while the next block, running under its own fresh epoch, proceeds cleanly.
 *
 * Technique mirrors db.queries.test.js: a real Database against a stubbed pool, no live
 * MariaDB.
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../fixtures/config');
const Utility           = require('../../src/utility');
const Database          = require('../../src/db');

// A stubbed transaction connection whose query() records every SQL string it is asked to
// run, so a test can assert a fenced (zombie) write never reached the driver.
function makeConn() {
    return {
        query:            sinon.stub().resolves([]),
        release:          sinon.stub().resolves(),
        beginTransaction: sinon.stub().resolves(),
        commit:           sinon.stub().resolves(),
        rollback:         sinon.stub().resolves()
    };
}

function makeDb(conn) {
    const config  = getTestConfig();
    const util    = new Utility();
    sinon.stub(util, 'logError');
    const indexer = { config, util };
    const db      = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', indexer);
    db.pool = { getConnection: sinon.stub().resolves(conn) };
    return db;
}

afterEach(function () { sinon.restore(); });

describe('Database watchdog-fence epoch (M-16) @regression @tier1', function () {

    it('advances the epoch on every transaction teardown (begin/commit/rollback)', async function () {
        const db = makeDb(makeConn());
        const start = db.currentTxEpoch();

        await db.beginTransaction();
        const afterBegin1 = db.currentTxEpoch();
        assert.ok(afterBegin1 > start, 'beginTransaction assigns a fresh epoch');

        await db.commitTransaction();
        assert.ok(db.currentTxEpoch() > afterBegin1, 'commit bumps the epoch');

        await db.beginTransaction();
        const afterBegin2 = db.currentTxEpoch();
        await db.rollbackTransaction();
        assert.ok(db.currentTxEpoch() > afterBegin2, 'rollback bumps the epoch');
    });

    it('allows a write issued under the current epoch (non-timeout path unaffected)', async function () {
        const conn = makeConn();
        const db   = makeDb(conn);

        await db.beginTransaction();
        const epoch = db.currentTxEpoch();
        const rows  = await db.runInTxEpoch(epoch, async () => {
            return db.doQuery('INSERT INTO fence_ok VALUES (1)', []);
        });

        assert.deepStrictEqual(rows, []);
        assert.ok(
            conn.query.getCalls().some((c) => /fence_ok/.test(c.args[0])),
            'the matching-epoch write reached the driver'
        );
        await db.commitTransaction();
    });

    it('never fences a caller with no epoch context (federation RPC read mid-block)', async function () {
        const conn = makeConn();
        const db   = makeDb(conn);

        // A block is mid-flight under some epoch, but this caller runs OUTSIDE any
        // runInTxEpoch context (getStore() undefined), so it must not be fenced.
        await db.beginTransaction();
        await assert.doesNotReject(() => db.doQuery('SELECT 1', []));
        await db.commitTransaction();
    });

    it('rejects a zombie write after rollback while the next block proceeds cleanly', async function () {
        const conn = makeConn();
        const db   = makeDb(conn);

        // --- Block C: begins, then "hangs" partway through processing ---
        await db.beginTransaction();
        const epochC = db.currentTxEpoch();

        let resumeZombie;
        const zombiePromise = db.runInTxEpoch(epochC, async () => {
            // First write lands normally inside block C's epoch.
            await db.doQuery('INSERT INTO block_c_early VALUES (1)', []);
            // Simulate the hang the watchdog will trip on.
            await new Promise((r) => { resumeZombie = r; });
            // Zombie continuation: resumes only AFTER the watchdog fired, block C was
            // rolled back, and a later block took over the shared connection.
            return db.doQuery('INSERT INTO zombie_write VALUES (1)', []);
        });

        // Let the first write run before the hang.
        await new Promise((r) => setImmediate(r));

        // --- Watchdog fires: outer catch rolls block C back (we abandon zombiePromise) ---
        await db.rollbackTransaction();

        // --- Block C retry: fresh transaction, fresh epoch, clean write ---
        await db.beginTransaction();
        const epochRetry = db.currentTxEpoch();
        assert.notStrictEqual(epochRetry, epochC, 'retry runs under a distinct epoch');
        await db.runInTxEpoch(epochRetry, async () => {
            await db.doQuery('INSERT INTO block_c_retry VALUES (1)', []);
        });

        // --- Now the zombie resumes and attempts its post-rollback write ---
        // util.throwError throws a raw string (codebase convention), so match the rejection
        // reason itself rather than an .message property.
        resumeZombie();
        await assert.rejects(() => zombiePromise, /transaction fenced \(M-16\)/);

        // The zombie's SQL must never have reached the driver; the legit writes did.
        const seen = conn.query.getCalls().map((c) => c.args[0]);
        assert.ok(seen.some((q) => /block_c_early/.test(q)),  'block C early write ran');
        assert.ok(seen.some((q) => /block_c_retry/.test(q)),  'block C retry write ran');
        assert.ok(!seen.some((q) => /zombie_write/.test(q)),  'zombie write never hit the driver');

        await db.commitTransaction();
    });

    it('never fences a SIBLING Database instance read inside the block epoch context', async function () {
        // The indexer process holds several Database instances (indexer DB, decoder DB,
        // hub-DB mirror). Fee validation reads oracle prices through the hub-mirror
        // instance INSIDE the block/dry-run epoch context; that instance's own epoch
        // counter never advances, so an owner-blind fence rejects every such read
        // (regtest live failure 2026-07-08: every feequote dry-run fenced its price
        // read). The fence must apply only to the instance that owns the guarded
        // transaction.
        const connA = makeConn();
        const dbA   = makeDb(connA);   // owns the block transaction
        const connB = makeConn();
        const dbB   = makeDb(connB);   // sibling (hub-mirror style, no transactions ever)

        await dbA.beginTransaction();
        const epoch = dbA.currentTxEpoch();
        await dbA.runInTxEpoch(epoch, async () => {
            // Sibling read inside the guarded context: must pass, both live and after
            // the owner's teardown (the zombie hazard is the owner's shared connection,
            // never a sibling's pool).
            await assert.doesNotReject(() => dbB.doQuery('SELECT price FROM price_snapshots', []));
        });
        await dbA.rollbackTransaction();

        // Even a ZOMBIE continuation's sibling read is not the fence's business: only
        // the owner's write is rejected.
        await dbA.beginTransaction();
        await dbA.runInTxEpoch(epoch, async () => {  // stale epoch on purpose
            await assert.doesNotReject(() => dbB.doQuery('SELECT 1', []));
            await assert.rejects(() => dbA.doQuery('INSERT INTO zombie VALUES (1)', []),
                /transaction fenced \(M-16\)/);
        });
        await dbA.commitTransaction();

        assert.ok(
            connB.query.getCalls().some((c) => /price_snapshots/.test(c.args[0])),
            'sibling read reached its own driver'
        );
    });

    it('fences a zombie savepoint call after rollback', async function () {
        const conn = makeConn();
        const db   = makeDb(conn);

        await db.beginTransaction();
        const epochC = db.currentTxEpoch();

        let resume;
        const zombie = db.runInTxEpoch(epochC, async () => {
            await new Promise((r) => { resume = r; });
            return db.createSavepoint('vm_execute_1');
        });

        await db.rollbackTransaction();
        await db.beginTransaction(); // a later block now owns the connection

        resume();
        await assert.rejects(() => zombie, /transaction fenced \(M-16\)/);
        assert.ok(
            !conn.query.getCalls().some((c) => /SAVEPOINT/.test(c.args[0])),
            'zombie SAVEPOINT never reached the driver'
        );
        await db.commitTransaction();
    });
});
