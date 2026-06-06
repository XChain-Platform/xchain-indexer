/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Query Error Propagation Tests
 *
 * Verifies doQuery() error handling:
 * - Outside transaction: catches error, returns empty array (safe fallback)
 * - Inside transaction: re-throws error so block-level catch triggers rollback
 */

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createChaosDb, FakeConnection } = require('../setup/harness');

describe('Chaos — Query Error Propagation', function () {
    this.timeout(10000);

    let db, conn;

    beforeEach(function () {
        db = createChaosDb();
        conn = db.pool.connection;
    });

    afterEach(function () {
        sinon.restore();
    });

    it('QP-01: query error outside transaction returns empty array', async function () {
        conn.query.rejects(new Error('table not found'));
        const results = await db.doQuery('SELECT * FROM missing');
        assert.deepStrictEqual(results, []);
    });

    it('QP-02: query error outside transaction logs the error', async function () {
        const logSpy = sinon.spy(db.util, 'logError');
        conn.query.rejects(new Error('table not found'));
        await db.doQuery('SELECT * FROM missing');
        assert.ok(logSpy.calledOnce);
        assert.ok(String(logSpy.firstCall.args[0]).includes('Error running database query'));
    });

    it('QP-03: query error inside transaction re-throws the error', async function () {
        // Simulate being inside a transaction
        db.transactionConnection = conn;
        conn.query.rejects(new Error('deadlock detected'));
        try {
            await db.doQuery('INSERT INTO foo VALUES (1)');
            assert.fail('Should have thrown');
        } catch (e) {
            assert.ok(e.message.includes('deadlock detected'));
        }
    });

    it('QP-04: query error inside transaction still logs before re-throwing', async function () {
        db.transactionConnection = conn;
        const logSpy = sinon.spy(db.util, 'logError');
        conn.query.rejects(new Error('deadlock detected'));
        try {
            await db.doQuery('INSERT INTO foo VALUES (1)');
        } catch (e) {
            // expected
        }
        assert.ok(logSpy.calledOnce, 'Should log even when re-throwing');
    });

    it('QP-05: connection released after error outside transaction', async function () {
        conn.query.rejects(new Error('syntax error'));
        await db.doQuery('INVALID SQL');
        assert.ok(conn.release.calledOnce, 'Should release connection after non-tx error');
    });

    it('QP-06: connection NOT released after error inside transaction', async function () {
        db.transactionConnection = conn;
        conn.query.rejects(new Error('deadlock'));
        try {
            await db.doQuery('INSERT INTO foo VALUES (1)');
        } catch (e) {
            // expected
        }
        assert.ok(conn.release.notCalled, 'Should NOT release transaction connection on error');
    });

    it('QP-07: null query returns empty array without touching pool', async function () {
        const results = await db.doQuery(null);
        assert.deepStrictEqual(results, []);
        assert.strictEqual(db.pool.callCount, 0, 'Pool should not be called for null query');
    });

    it('QP-08: successful query returns results normally', async function () {
        const expected = [{ id: 1, name: 'test' }];
        conn.query.resolves(expected);
        // Outside transaction
        const results = await db.doQuery('SELECT * FROM test');
        assert.deepStrictEqual(results, expected);
        // Inside transaction
        db.transactionConnection = conn;
        conn.query.resolves(expected);
        const txResults = await db.doQuery('SELECT * FROM test');
        assert.deepStrictEqual(txResults, expected);
    });
});
