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
 * Chaos test harness — shared helpers for resilience testing
 *
 * Provides FakePool, FakeConnection, and createChaosDb() so we can
 * test real Database class logic with a controllable fake pool.
 */

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const sinon = require('sinon');
const { getTestConfig } = require('../../fixtures/config');
const Utility = require('../../../src/utility.js');

/**
 * Fake MariaDB connection — mimics the interface returned by pool.getConnection()
 */
class FakeConnection {
    constructor() {
        this.query = sinon.stub().resolves([]);
        this.beginTransaction = sinon.stub().resolves();
        this.commit = sinon.stub().resolves();
        this.rollback = sinon.stub().resolves();
        this.release = sinon.stub().resolves();
    }
}

/**
 * Fake MariaDB pool — controllable mock of mariadb.createPool() return value
 *
 * Usage:
 *   pool.setFailures(3)        — next 3 calls to getConnection() throw, then succeed
 *   pool.setAlwaysFail(true)   — all calls throw until disabled
 *   pool.setConnection(conn)   — return a specific FakeConnection instance
 */
class FakePool {
    constructor() {
        this.connection = new FakeConnection();
        this.failuresRemaining = 0;
        this.alwaysFail = false;
        this.error = new Error('Connection refused');
        this.callCount = 0;
    }

    setFailures(n) {
        this.failuresRemaining = n;
    }

    setAlwaysFail(enabled, error) {
        this.alwaysFail = enabled;
        if (error) this.error = error;
    }

    setConnection(conn) {
        this.connection = conn;
    }

    async getConnection() {
        this.callCount++;
        if (this.alwaysFail) {
            throw this.error;
        }
        if (this.failuresRemaining > 0) {
            this.failuresRemaining--;
            throw this.error;
        }
        return this.connection;
    }
}

/**
 * Creates a real Database instance with its pool replaced by a FakePool.
 * This lets us test the actual getConnection(), doQuery(), circuit breaker,
 * and backoff logic without needing a real MariaDB.
 *
 * Options:
 *   circuitThreshold  — override circuit breaker threshold (default 10)
 *   circuitCooldown   — override circuit breaker cooldown ms (default 30000)
 */
function createChaosDb(options = {}) {
    const Database = require('../../../src/db.js');
    const config = getTestConfig();
    const util = new Utility();

    // Create a minimal indexer object to satisfy the Database constructor
    const indexer = { config, util };

    // Instantiate the real Database — this creates a real mariadb pool
    const db = new Database('localhost', 3306, 'test_db', 'root', '', indexer);

    // Replace the real pool with our fake
    db.pool = new FakePool();

    // Override circuit breaker settings if requested
    if (options.circuitThreshold !== undefined)
        db.circuitThreshold = options.circuitThreshold;
    if (options.circuitCooldown !== undefined)
        db.circuitCooldown = options.circuitCooldown;

    return db;
}

module.exports = {
    FakePool,
    FakeConnection,
    createChaosDb,
    getTestConfig,
    Utility,
};
