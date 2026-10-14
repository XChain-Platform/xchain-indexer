'use strict';

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
 * Schema migration runner: the session sql_mode guard on the migration connection.
 *
 * The pool requests the strict mode only through initSql. runMigrationsInner reads back what
 * the server reports on the connection that runs the files and refuses a lax or
 * NO_BACKSLASH_ESCAPES session before taking the lock or touching the ledger.
 *
 ********************************************************************/

const { assert, Database } = require('./helpers/migration_fixtures.js');
const { SESSION_SQL_MODE } = require('../../../../src/db/shared.js');

// Drive runMigrationsInner against a connection whose session reports `mode`.
async function runWithMode(mode) {
    const calls = [];
    const conn = {
        released: false, destroyed: false,
        async query(sql) {
            calls.push(sql);
            if (/@@SESSION\.sql_mode/i.test(sql)) return mode === undefined ? [] : [{ mode }];
            if (/GET_LOCK/i.test(sql)) return [{ l: 0 }];
            return [{}];
        },
        release() { conn.released = true; },
        destroy() { conn.destroyed = true; },
    };
    const db = { dbName: 'xchain_test', getConnection: async () => conn };
    let error = null;
    try { await Database.prototype.runMigrationsInner.call(db, {}); } catch (e) { error = e; }
    return { error, calls, conn };
}

describe('Database.runMigrationsInner() session sql_mode guard @regression @tier1', function () {
    it('proceeds to the lock when the session reports the pinned mode in any flag order', async function () {
        for (const mode of [SESSION_SQL_MODE, SESSION_SQL_MODE.split(',').reverse().join(',')]) {
            const { error, calls } = await runWithMode(mode);
            assert.strictEqual(error, null, mode);
            assert.ok(calls.some((sql) => /GET_LOCK/i.test(sql)), 'the run reaches GET_LOCK under ' + mode);
        }
    });

    it('refuses a lax, empty, unreadable or NO_BACKSLASH_ESCAPES session before the lock', async function () {
        for (const mode of ['', undefined, 'NO_ENGINE_SUBSTITUTION', SESSION_SQL_MODE + ',NO_BACKSLASH_ESCAPES']) {
            const { error, calls, conn } = await runWithMode(mode);
            assert.match(String(error && error.message), /must be strict and must not carry NO_BACKSLASH_ESCAPES/, String(mode));
            assert.deepStrictEqual(calls, ['SELECT @@SESSION.sql_mode AS mode'], 'nothing but the probe ran under ' + mode);
            assert.strictEqual(conn.released, false, 'a refused connection never returns to the pool');
            assert.strictEqual(conn.destroyed, true, 'a refused connection is destroyed');
        }
    });

    it('accepts STRICT_ALL_TABLES as the strict flag', async function () {
        const { error } = await runWithMode('STRICT_ALL_TABLES,NO_ENGINE_SUBSTITUTION');
        assert.strictEqual(error, null);
    });
});
