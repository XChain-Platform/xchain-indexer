'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

const assert = require('assert');
const Database = require('../../../../src/db');

function createHarness(onQuery) {
    const queries = [];
    let connections = 0;
    const db = Object.create(Database.prototype);
    Object.assign(db, {
        util: {
            sleep: async () => {},
            throwError(message) { throw new Error(message); },
        },
        getConnection: async () => {
            const attempt = ++connections;
            return {
                async query(sql) {
                    queries.push({ attempt, sql });
                    return onQuery(sql, attempt, queries);
                },
                async release() {},
            };
        },
    });
    return { db, queries, connections: () => connections };
}

const drops = queries => queries.filter(entry => /^DROP TABLE/i.test(entry.sql));
const creates = queries => queries.filter(entry => /^CREATE TABLE/i.test(entry.sql));

describe('createTable retry ownership @regression @tier1', function () {
    it('does not issue the definition DROP on the first attempt', async function () {
        const harness = createHarness(async () => []);
        await harness.db.createTable('blocks.sql');
        assert.strictEqual(drops(harness.queries).length, 0);
        assert.strictEqual(creates(harness.queries).length, 1);
    });

    it('does not retry or DROP when CREATE reports an existing table', async function () {
        const exists = Object.assign(new Error('already exists'), {
            errno: 1050,
            code: 'ER_TABLE_EXISTS_ERROR',
        });
        const harness = createHarness(async sql => {
            if(/^CREATE TABLE/i.test(sql)) throw exists;
            return [];
        });
        await assert.rejects(harness.db.createTable('blocks.sql'), error => error === exists);
        assert.strictEqual(harness.connections(), 1);
        assert.strictEqual(drops(harness.queries).length, 0);
    });

    it('drops and rebuilds only after this call created a partial table', async function () {
        let failed = false;
        const harness = createHarness(async sql => {
            if(/^CREATE INDEX/i.test(sql) && !failed){
                failed = true;
                throw new Error('transient index failure');
            }
            return [];
        });
        await harness.db.createTable('blocks.sql');
        assert.strictEqual(harness.connections(), 2);
        assert.strictEqual(drops(harness.queries).length, 1);
        assert.strictEqual(drops(harness.queries)[0].attempt, 2);
        assert.strictEqual(creates(harness.queries).length, 2);
    });

    it('does not DROP after CREATE itself fails transiently', async function () {
        let failed = false;
        const harness = createHarness(async sql => {
            if(/^CREATE TABLE/i.test(sql) && !failed){
                failed = true;
                throw new Error('transient create failure');
            }
            return [];
        });
        await harness.db.createTable('blocks.sql');
        assert.strictEqual(harness.connections(), 2);
        assert.strictEqual(drops(harness.queries).length, 0);
        assert.strictEqual(creates(harness.queries).length, 2);
    });
});
