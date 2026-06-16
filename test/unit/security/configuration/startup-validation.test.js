'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');

// ---------------------------------------------------------------------------
// Suite: database name validation
// ---------------------------------------------------------------------------

describe('Security: database name validation @regression @tier4', function () {
    const validNamePattern = /^[A-Za-z0-9_]+$/;

    it('SEC-37: database name \'XChain_BTC_Regtest_Indexer\' → valid', function () {
        assert.strictEqual(validNamePattern.test('XChain_BTC_Regtest_Indexer'), true);
    });

    it('SEC-38: database name with spaces → rejected', function () {
        assert.strictEqual(validNamePattern.test('XChain Indexer'), false);
    });

    it('SEC-39: database name with SQL injection chars → rejected', function () {
        assert.strictEqual(validNamePattern.test('XChain; DROP TABLE--'), false);
    });

    it('SEC-40: database name with backticks → rejected', function () {
        assert.strictEqual(validNamePattern.test('XChain`Indexer'), false);
    });

    it('SEC-39b: database name with parentheses → rejected', function () {
        assert.strictEqual(validNamePattern.test('XChain()'), false);
    });

    it('SEC-39c: database name with quotes → rejected', function () {
        assert.strictEqual(validNamePattern.test("XChain'Indexer"), false);
    });
});

// ---------------------------------------------------------------------------
// Suite: connection pool hardening
// ---------------------------------------------------------------------------

describe('Security: connection pool timeout configuration @regression @tier4', function () {
    const Database = require('../../../../src/db.js');
    const { createMockIndexer } = require('../../../fixtures/mocks');

    function makeDb() {
        const indexer = createMockIndexer();
        return new Database('localhost', 3306, 'test_db', 'user', 'pass', indexer);
    }

    it('SEC-41: connection pool has connectTimeout set', function () {
        const db = makeDb();
        assert.strictEqual(db.connectionPoolParams.connectTimeout, 10000,
            'connectTimeout should be 10000ms');
    });

    it('SEC-42: connection pool has acquireTimeout set', function () {
        const db = makeDb();
        assert.strictEqual(db.connectionPoolParams.acquireTimeout, 10000,
            'acquireTimeout should be 10000ms');
    });

    it('SEC-42b: connection pool has idleTimeout set', function () {
        const db = makeDb();
        assert.strictEqual(db.connectionPoolParams.idleTimeout, 60000,
            'idleTimeout should be 60000ms');
    });
});
