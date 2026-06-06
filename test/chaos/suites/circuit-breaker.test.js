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
 * Circuit Breaker Tests
 *
 * Verifies the circuit breaker state machine in Database.getConnection():
 * closed → open (after threshold failures) → half-open (after cooldown) → closed (on success)
 */

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createChaosDb, FakeConnection } = require('../setup/harness');

describe('Chaos — Circuit Breaker', function () {
    this.timeout(10000);

    let db;

    afterEach(function () {
        sinon.restore();
    });

    it('CB-01: starts in closed state', function () {
        db = createChaosDb();
        assert.strictEqual(db.circuitState, 'closed');
        assert.strictEqual(db.circuitFailures, 0);
    });

    it('CB-02: successful connection resets failure count', async function () {
        db = createChaosDb({ circuitThreshold: 20 });
        // Accumulate some failures then succeed
        db.pool.setFailures(3);
        // Stub sleep to be instant
        sinon.stub(db.util, 'sleep').resolves();
        const conn = await db.getConnection();
        assert.ok(conn);
        assert.strictEqual(db.circuitFailures, 0);
    });

    it('CB-03: failures increment circuitFailures counter', async function () {
        db = createChaosDb({ circuitThreshold: 20 });
        db.pool.setAlwaysFail(true);
        sinon.stub(db.util, 'sleep').resolves();
        try {
            await db.getConnection();
        } catch (e) {
            // Will throw after maxAttempts (30), but circuitFailures should be > 0
        }
        // After 20 failures, circuit opens and throws before reaching 30
        assert.ok(db.circuitFailures >= db.circuitThreshold);
    });

    it('CB-04: opens after circuitThreshold consecutive failures', async function () {
        db = createChaosDb({ circuitThreshold: 5 });
        db.pool.setAlwaysFail(true);
        sinon.stub(db.util, 'sleep').resolves();
        try {
            await db.getConnection();
        } catch (e) {
            assert.ok(e.message.includes('Circuit breaker opened'));
        }
        assert.strictEqual(db.circuitState, 'open');
        assert.strictEqual(db.circuitFailures, 5);
    });

    it('CB-05: open state rejects immediately without attempting connection', async function () {
        db = createChaosDb({ circuitThreshold: 5 });
        // Force circuit open with future cooldown
        db.circuitState = 'open';
        db.circuitOpenUntil = Date.now() + 60000;
        const poolCallsBefore = db.pool.callCount;
        try {
            await db.getConnection();
            assert.fail('Should have thrown');
        } catch (e) {
            assert.ok(e.message.includes('Circuit breaker open'));
        }
        // Pool should NOT have been called
        assert.strictEqual(db.pool.callCount, poolCallsBefore);
    });

    it('CB-06: transitions to half-open after cooldown expires', async function () {
        db = createChaosDb({ circuitThreshold: 5 });
        // Force circuit open with expired cooldown
        db.circuitState = 'open';
        db.circuitOpenUntil = Date.now() - 1000; // cooldown already expired
        const conn = await db.getConnection();
        assert.ok(conn);
        // Should have transitioned through half-open to closed
        assert.strictEqual(db.circuitState, 'closed');
    });

    it('CB-07: successful connection in half-open resets to closed', async function () {
        db = createChaosDb();
        db.circuitState = 'half-open';
        db.circuitFailures = 5;
        const conn = await db.getConnection();
        assert.ok(conn);
        assert.strictEqual(db.circuitState, 'closed');
        assert.strictEqual(db.circuitFailures, 0);
    });

    it('CB-08: failed connection in half-open re-opens circuit', async function () {
        db = createChaosDb({ circuitThreshold: 1 });
        db.circuitState = 'half-open';
        db.circuitFailures = 0;
        db.pool.setAlwaysFail(true);
        sinon.stub(db.util, 'sleep').resolves();
        try {
            await db.getConnection();
            assert.fail('Should have thrown');
        } catch (e) {
            assert.ok(e.message.includes('Circuit breaker opened'));
        }
        assert.strictEqual(db.circuitState, 'open');
    });

    it('CB-09: circuit breaker is per-Database-instance', async function () {
        const db1 = createChaosDb({ circuitThreshold: 3 });
        const db2 = createChaosDb({ circuitThreshold: 3 });
        // Open db1's circuit
        db1.circuitState = 'open';
        db1.circuitOpenUntil = Date.now() + 60000;
        // db2 should still be closed and work fine
        const conn = await db2.getConnection();
        assert.ok(conn);
        assert.strictEqual(db2.circuitState, 'closed');
        assert.strictEqual(db1.circuitState, 'open');
    });

    it('CB-10: circuitFailures resets on any successful connection in closed state', async function () {
        db = createChaosDb({ circuitThreshold: 20 });
        sinon.stub(db.util, 'sleep').resolves();
        // Fail 5 times then succeed
        db.pool.setFailures(5);
        await db.getConnection();
        assert.strictEqual(db.circuitFailures, 0);
        // Fail 3 more times then succeed
        db.pool.setFailures(3);
        await db.getConnection();
        assert.strictEqual(db.circuitFailures, 0);
    });

    it('CB-11: open circuit throws descriptive error message', async function () {
        db = createChaosDb({ circuitThreshold: 5 });
        db.circuitState = 'open';
        db.circuitOpenUntil = Date.now() + 60000;
        try {
            await db.getConnection();
            assert.fail('Should have thrown');
        } catch (e) {
            assert.ok(e.message.includes('Circuit breaker open'));
            assert.ok(e.message.includes('cooldown'));
        }
    });

    it('CB-12: half-open logs transition message', async function () {
        db = createChaosDb();
        db.circuitState = 'open';
        db.circuitOpenUntil = Date.now() - 1000;
        const logSpy = sinon.spy(console, 'log');
        await db.getConnection();
        const halfOpenMsg = logSpy.args.find(a => String(a[0]).includes('half-open'));
        assert.ok(halfOpenMsg, 'Should log half-open transition');
        const closedMsg = logSpy.args.find(a => String(a[0]).includes('connection restored'));
        assert.ok(closedMsg, 'Should log circuit closed');
    });
});
