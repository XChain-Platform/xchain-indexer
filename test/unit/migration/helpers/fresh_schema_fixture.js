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

async function verifyFreshSchema(existingTable, options = {}) {
    const created = [];
    const order = [];
    let recorded = 0;
    const connection = {
        async query(sql, params) {
            if(/GET_LOCK/i.test(sql)){
                order.push('lock');
                return [{ l: 1 }];
            }
            if(/RELEASE_LOCK/i.test(sql)){
                order.push('release-lock');
                return [{ l: 1 }];
            }
            if(/information_schema\.tables/i.test(sql))
                return params[1] === existingTable ? [{}] : [];
            throw new Error('unexpected statement: ' + sql);
        },
        async release() {},
    };
    const db = {
        dbName: 'fake_indexer',
        util: { throwError(message) { throw new Error(message); } },
        getConnection: async () => connection,
        createTable: async file => {
            if(options.failCreateAt === created.length + 1) throw new Error('create failed');
            created.push(file);
            order.push('create');
        },
        alterTableForDrift: async () => {},
        reconcileTableIndexes: async () => {},
        recordFreshSchemaMigrations: async (conn, lockOptions) => {
            assert.strictEqual(conn, connection);
            assert.strictEqual(lockOptions && lockOptions.lockHeld, true);
            recorded++;
            order.push('seed');
        },
        schemaShapeSummary: () => 'Schema shape: test fixture.',
        verifyTables: Database.prototype.verifyTables,
    };
    let error = null;
    try { await db.verifyTables(); } catch(caught){ error = caught; }
    return { created, recorded, order, error };
}

module.exports = { verifyFreshSchema };
