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
 * test/unit/db_queries.test.js
 *
 * Unit tests for Database query methods (SELECT/INSERT/UPDATE/DELETE).
 *
 * Technique: stub doQuery on the prototype-borrowed object so every
 * method under test exercises real method logic against injected SQL
 * results; no live MariaDB required.
 *
 * This file holds the connection, transaction, savepoint and doQuery tests.
 * The rest of the Database query suite lives beside it in db_queries.test/,
 * one file per behaviour, and db_queries.test/helpers/db_stub.js holds the
 * makeDb and dbWithDoQuery stubs they all share.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { makeDb } = require('./db_queries.test/helpers/db_stub');

afterEach(function () {
    sinon.restore();
});

// ---------------------------------------------------------------------------
// getConnection (circuit-breaker)
// ---------------------------------------------------------------------------
describe('Database.getConnection() circuit breaker @regression @tier1', function () {
    it('returns a connection on first successful pool.getConnection()', async function () {
        const db   = makeDb();
        const conn = { query: sinon.stub(), release: sinon.stub().resolves() };
        db.pool.getConnection.resolves(conn);
        const result = await db.getConnection();
        assert.strictEqual(result, conn);
    });

    it('returns the transactionConnection when one is active', async function () {
        const db   = makeDb();
        const fake = { query: sinon.stub() };
        db.transactionConnection = fake;
        const result = await db.getConnection();
        assert.strictEqual(result, fake);
        assert.strictEqual(db.pool.getConnection.callCount, 0, 'should not call pool.getConnection');
    });

    it('rejects immediately when circuit is open and cooldown has NOT expired', async function () {
        const db          = makeDb();
        db.circuitState   = 'open';
        db.circuitOpenUntil = Date.now() + 60000; // future
        sinon.stub(db.util, 'throwError').throws(new Error('Circuit breaker open'));
        await assert.rejects(() => db.getConnection(), /Circuit breaker open/);
    });

    it('transitions to half-open when circuit cooldown has expired', async function () {
        const db          = makeDb();
        db.circuitState   = 'open';
        db.circuitOpenUntil = Date.now() - 1; // already expired
        const conn = { query: sinon.stub(), release: sinon.stub().resolves() };
        db.pool.getConnection.resolves(conn);
        await db.getConnection();
        assert.strictEqual(db.circuitState, 'closed');
    });

    it('resets circuitFailures to 0 on successful connection', async function () {
        const db          = makeDb();
        db.circuitFailures = 5;
        const conn = { query: sinon.stub(), release: sinon.stub().resolves() };
        db.pool.getConnection.resolves(conn);
        await db.getConnection();
        assert.strictEqual(db.circuitFailures, 0);
    });
});

// ---------------------------------------------------------------------------
// beginTransaction / rollbackTransaction / commitTransaction
// ---------------------------------------------------------------------------
describe('Database transaction lifecycle @regression @tier1', function () {
    it('beginTransaction opens a connection and begins a transaction', async function () {
        const db   = makeDb();
        const conn = {
            query:            sinon.stub().resolves([]),
            release:          sinon.stub().resolves(),
            beginTransaction: sinon.stub().resolves(),
            commit:           sinon.stub().resolves(),
            rollback:         sinon.stub().resolves()
        };
        db.pool.getConnection.resolves(conn);
        await db.beginTransaction();
        assert.ok(conn.beginTransaction.calledOnce);
        assert.strictEqual(db.transactionConnection, conn);
    });

    it('rollbackTransaction rolls back and clears transactionConnection', async function () {
        const db   = makeDb();
        const conn = {
            rollback: sinon.stub().resolves(),
            release:  sinon.stub().resolves()
        };
        db.transactionConnection = conn;
        await db.rollbackTransaction();
        assert.ok(conn.rollback.calledOnce);
        assert.strictEqual(db.transactionConnection, null);
    });

    it('commitTransaction commits and returns true', async function () {
        const db   = makeDb();
        const conn = {
            commit:  sinon.stub().resolves(),
            release: sinon.stub().resolves()
        };
        db.transactionConnection = conn;
        const result = await db.commitTransaction();
        assert.strictEqual(result, true);
        assert.ok(conn.commit.calledOnce);
        assert.strictEqual(db.transactionConnection, null);
    });

    it('commitTransaction returns false when no transaction is active', async function () {
        const db     = makeDb();
        const result = await db.commitTransaction();
        assert.strictEqual(result, false);
    });
});

describe('Database transaction lifecycle @regression @tier1', function () {
    it('commitTransaction rolls back on commit failure', async function () {
        const db   = makeDb();
        const conn = {
            commit:   sinon.stub().rejects(new Error('commit fail')),
            rollback: sinon.stub().resolves(),
            release:  sinon.stub().resolves()
        };
        db.transactionConnection = conn;
        sinon.stub(db.util, 'throwError').throws(new Error('commitTransaction error'));
        await assert.rejects(() => db.commitTransaction(), /commitTransaction error/);
        assert.ok(conn.rollback.calledOnce);
        assert.strictEqual(db.transactionConnection, null);
    });
});

describe('Database staged hub push buffer @regression @tier1', function () {
    it('stageHubPush is inert when no per-block buffer is installed', function () {
        const db = makeDb();
        // No _stagedHubPushes installed: must not throw and must return nothing to drain.
        db.stageHubPush({ id: 1, pushType: 'price_round', payload: {} });
        assert.deepStrictEqual(db.takeStagedHubPushes(), []);
    });

    it('stageHubPush accumulates and takeStagedHubPushes drains + clears exactly once', function () {
        const db = makeDb();
        db._stagedHubPushes = [];
        db.stageHubPush({ id: 1, pushType: 'price_round', payload: { a: 1 } });
        db.stageHubPush({ id: 2, pushType: 'oracle_price', payload: { b: 2 } });
        const first = db.takeStagedHubPushes();
        assert.strictEqual(first.length, 2);
        assert.strictEqual(first[0].id, 1);
        assert.strictEqual(first[1].pushType, 'oracle_price');
        // Drained once: a second take yields nothing (no duplicate delivery).
        assert.deepStrictEqual(db.takeStagedHubPushes(), []);
    });

    it('a fresh per-block buffer discards a prior (rolled-back) block staged rows', function () {
        const db = makeDb();
        db._stagedHubPushes = [];
        db.stageHubPush({ id: 9, pushType: 'price_round', payload: {} });
        // Simulate the next block start installing a fresh buffer (prior block rolled back).
        db._stagedHubPushes = [];
        assert.deepStrictEqual(db.takeStagedHubPushes(), []);
    });
});

// ---------------------------------------------------------------------------
// doQuery
// ---------------------------------------------------------------------------
describe('Database.doQuery() @regression @tier1', function () {
    it('calls pool.getConnection and conn.query, releases when not in tx', async function () {
        const db   = makeDb();
        const conn = {
            query:   sinon.stub().resolves([{ id: 1 }]),
            release: sinon.stub().resolves()
        };
        db.pool.getConnection.resolves(conn);
        const results = await db.doQuery('SELECT 1', []);
        assert.deepStrictEqual(results, [{ id: 1 }]);
        assert.ok(conn.release.calledOnce);
    });

    it('returns [] when query is null/undefined', async function () {
        const db      = makeDb();
        const results = await db.doQuery(null);
        assert.deepStrictEqual(results, []);
    });

    it('converts boxed-object args to strings (except Buffer)', async function () {
        const db   = makeDb();
        const conn = {
            query:   sinon.stub().resolves([]),
            release: sinon.stub().resolves()
        };
        db.pool.getConnection.resolves(conn);
        const bigObj = { toString: () => '99999' }; // simulates mathjs bignumber
        const buf    = Buffer.from('binary');
        await db.doQuery('SELECT ?', [bigObj, buf]);
        const passedArgs = conn.query.firstCall.args[1];
        assert.strictEqual(passedArgs[0], '99999', 'boxed object should be .toString()');
        assert.ok(Buffer.isBuffer(passedArgs[1]), 'Buffer must pass through unchanged');
    });

    it('swallows errors and returns [] outside a transaction', async function () {
        const db   = makeDb();
        const conn = {
            query:   sinon.stub().rejects(new Error('query error')),
            release: sinon.stub().resolves()
        };
        db.pool.getConnection.resolves(conn);
        const results = await db.doQuery('SELECT 1');
        assert.deepStrictEqual(results, []);
    });

    it('re-throws errors inside a transaction', async function () {
        const db   = makeDb();
        const conn = {
            query:   sinon.stub().rejects(new Error('tx query error')),
            release: sinon.stub().resolves()
        };
        db.transactionConnection = conn;
        await assert.rejects(() => db.doQuery('SELECT 1'), /tx query error/);
    });
});

// doQueryStrict: the consensus-input variant that ALWAYS throws on query error
// and never swallows it. doQuery collapses a non-transactional error into [] - indistinguishable
// from an empty result - which can fork the ledger on a transient DB fault; a
// strict read lets block processing roll back and retry.
describe('Database.doQueryStrict() @regression @tier1', function () {
    it('returns rows on success and releases when not in a transaction', async function () {
        const db   = makeDb();
        const conn = {
            query:   sinon.stub().resolves([{ id: 1 }]),
            release: sinon.stub().resolves()
        };
        db.pool.getConnection.resolves(conn);
        const results = await db.doQueryStrict('SELECT 1', []);
        assert.deepStrictEqual(results, [{ id: 1 }]);
        assert.ok(conn.release.calledOnce);
    });

    it('returns [] when query is null/undefined', async function () {
        const db = makeDb();
        assert.deepStrictEqual(await db.doQueryStrict(null), []);
    });

    it('THROWS on a query error outside a transaction (unlike doQuery, which swallows)', async function () {
        const db   = makeDb();
        const conn = {
            query:   sinon.stub().rejects(new Error('strict query error')),
            release: sinon.stub().resolves()
        };
        db.pool.getConnection.resolves(conn);
        await assert.rejects(() => db.doQueryStrict('SELECT 1'), /strict query error/);
        assert.ok(conn.release.calledOnce, 'connection must still be released on throw');
    });
});

// ---------------------------------------------------------------------------
// releaseConnection
// ---------------------------------------------------------------------------
describe('Database.releaseConnection() @regression @tier1', function () {
    it('does nothing when no transactionConnection', async function () {
        const db = makeDb();
        // Should not throw
        await db.releaseConnection();
        assert.strictEqual(db.transactionConnection, null);
    });

    it('releases and clears transactionConnection when set', async function () {
        const db   = makeDb();
        const conn = { release: sinon.stub().resolves() };
        db.transactionConnection = conn;
        await db.releaseConnection();
        assert.ok(conn.release.calledOnce);
        assert.strictEqual(db.transactionConnection, null);
    });
});

// ---------------------------------------------------------------------------
// savepoint methods
// ---------------------------------------------------------------------------
describe('Database savepoint methods @regression @tier1', function () {
    // Savepoints require an active transactionConnection; calling them
    // without one throws rather than silently doing nothing.

    function makeActiveDb() {
        const db   = makeDb();
        const conn = {
            query:   sinon.stub().resolves([]),
            release: sinon.stub().resolves()
        };
        db.transactionConnection = conn;
        return { db, conn };
    }

    it('createSavepoint throws when no active transaction', async function () {
        const db = makeDb();
        await assert.rejects(() => db.createSavepoint('sp1'), /createSavepoint requires an active transaction/);
    });

    it('createSavepoint runs SAVEPOINT statement via transactionConnection', async function () {
        const { db, conn } = makeActiveDb();
        await db.createSavepoint('sp1');
        assert.match(conn.query.firstCall.args[0], /SAVEPOINT/i);
    });

    it('releaseSavepoint throws when no active transaction', async function () {
        const db = makeDb();
        await assert.rejects(() => db.releaseSavepoint('sp1'), /releaseSavepoint requires an active transaction/);
    });

    it('releaseSavepoint runs RELEASE SAVEPOINT via transactionConnection', async function () {
        const { db, conn } = makeActiveDb();
        await db.releaseSavepoint('sp1');
        assert.match(conn.query.firstCall.args[0], /RELEASE SAVEPOINT/i);
    });

    it('rollbackToSavepoint throws when no active transaction', async function () {
        const db = makeDb();
        await assert.rejects(() => db.rollbackToSavepoint('sp1'), /rollbackToSavepoint requires an active transaction/);
    });

    it('rollbackToSavepoint runs ROLLBACK TO SAVEPOINT via transactionConnection', async function () {
        const { db, conn } = makeActiveDb();
        await db.rollbackToSavepoint('sp1');
        assert.match(conn.query.firstCall.args[0], /ROLLBACK TO/i);
    });
});
