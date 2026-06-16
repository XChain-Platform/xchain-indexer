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
 * Exponential Backoff & Retry Tests
 *
 * Verifies the retry logic in Database.getConnection():
 * exponential delays (500ms base, doubling, capped at 15s), jitter, max 30 attempts.
 */

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createChaosDb } = require('../setup/harness');

describe('Chaos — Exponential Backoff & Retry', function () {
    this.timeout(10000);

    let db, sleepStub;

    beforeEach(function () {
        db = createChaosDb({ circuitThreshold: 50 }); // high threshold so circuit breaker doesn't interfere
        sleepStub = sinon.stub(db.util, 'sleep').resolves();
    });

    afterEach(function () {
        sinon.restore();
    });

    it('BR-01: first retry delay starts at ~500ms base', async function () {
        db.pool.setFailures(1);
        await db.getConnection();
        assert.strictEqual(sleepStub.callCount, 1);
        const delay = sleepStub.firstCall.args[0];
        // baseDelay=500, jitter up to 30% = 500 to 650
        assert.ok(delay >= 500 && delay <= 650, 'First delay should be 500-650ms, got ' + delay);
    });

    it('BR-02: delays double each attempt', async function () {
        db.pool.setFailures(4);
        // Stub Math.random to return 0 (no jitter) for predictable timing
        sinon.stub(Math, 'random').returns(0);
        await db.getConnection();
        assert.strictEqual(sleepStub.callCount, 4);
        // Expected: 500, 1000, 2000, 4000
        assert.strictEqual(sleepStub.getCall(0).args[0], 500);
        assert.strictEqual(sleepStub.getCall(1).args[0], 1000);
        assert.strictEqual(sleepStub.getCall(2).args[0], 2000);
        assert.strictEqual(sleepStub.getCall(3).args[0], 4000);
    });

    it('BR-03: delay caps at maxDelay (15000ms)', async function () {
        db.pool.setFailures(8);
        sinon.stub(Math, 'random').returns(0);
        await db.getConnection();
        // Attempt 6: 500*2^5 = 16000 → capped at 15000
        const delays = sleepStub.args.map(a => a[0]);
        for (const d of delays) {
            assert.ok(d <= 15000 + 4500, 'Delay should not exceed 15000 + 30% jitter, got ' + d);
        }
        // Check that at least one delay hit the cap
        assert.ok(delays.some(d => d >= 15000), 'Should hit the 15s cap');
    });

    it('BR-04: jitter adds 0-30% randomness to delay', async function () {
        db.pool.setFailures(1);
        // jitter = floor(random * delay * 0.3) => floor(0.5 * 500 * 0.3) = floor(75) = 75
        sinon.stub(Math, 'random').returns(0.5);
        await db.getConnection();
        const delay = sleepStub.firstCall.args[0];
        // base=500, jitter=75, total=575
        assert.strictEqual(delay, 575);
    });

    it('BR-05: gives up after maxAttempts (30) with descriptive error', async function () {
        db.pool.setAlwaysFail(true);
        try {
            await db.getConnection();
            assert.fail('Should have thrown');
        } catch (e) {
            // Could be circuit breaker or max attempts — both are valid exits
            assert.ok(
                e.message.includes('30 attempts') || e.message.includes('Circuit breaker'),
                'Should mention attempts or circuit breaker: ' + e.message
            );
        }
    });

    it('BR-06: successful connection after N failures returns valid connection', async function () {
        db.pool.setFailures(5);
        const conn = await db.getConnection();
        assert.ok(conn);
        assert.strictEqual(sleepStub.callCount, 5);
        // No leftover state — next call should succeed immediately
        const conn2 = await db.getConnection();
        assert.ok(conn2);
        assert.strictEqual(sleepStub.callCount, 5); // no additional sleeps
    });

    it('BR-07: returns transactionConnection if one exists (bypasses pool)', async function () {
        const fakeTxConn = { id: 'transaction-conn' };
        db.transactionConnection = fakeTxConn;
        db.pool.setAlwaysFail(true); // pool would fail if called
        const conn = await db.getConnection();
        assert.strictEqual(conn, fakeTxConn);
        assert.strictEqual(db.pool.callCount, 0);
    });

    it('BR-08: backoff state resets between calls', async function () {
        // First call: 3 failures then success
        db.pool.setFailures(3);
        sinon.stub(Math, 'random').returns(0);
        await db.getConnection();
        assert.strictEqual(sleepStub.callCount, 3);
        // Second call: 2 failures then success — delays should start from base again
        db.pool.setFailures(2);
        await db.getConnection();
        assert.strictEqual(sleepStub.callCount, 5);
        // The 4th sleep (first of second call) should be base delay, not continuation
        assert.strictEqual(sleepStub.getCall(3).args[0], 500);
    });
});
