/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/integration/migration_live_schema_guard_types.test.js
 *
 * Drives the live-column guard's type and charset rules against server-produced
 * MariaDB metadata: a type change with no widening rule, a dropped fractional-second
 * precision, and a text MODIFY that names no charset or collation in a table whose
 * default differs from the column's.
 *
 * Requires an explicit TEST_DB_* endpoint. Run it with bin/run-db-tiers.sh.
 */

'use strict';
process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';
const assert  = require('assert');
const crypto  = require('crypto');
const mariadb = require('mariadb');
const Database = require('../../src/db');
const { assertNoLiveColumnLoss } = require('../../src/db/database/migration_live_schema_guard.js');
const DB_HOST = process.env.TEST_DB_HOST || '127.0.0.1';
const DB_PORT = parseInt(process.env.TEST_DB_PORT || '3306');
const DB_USER = process.env.TEST_DB_USER || 'root';
const DB_PASS = process.env.TEST_DB_PASS || '';
const DB_BASE = process.env.TEST_INDEXER_DB || 'xchain_test_indexer';
function scopedDbName() {
    const suffix = '_guard_types_' + crypto.createHash('sha1').update(__filename).digest('hex').slice(0, 6);
    if (DB_BASE.length + suffix.length <= 64) return DB_BASE + suffix;
    const baseDigest = crypto.createHash('sha1').update(DB_BASE).digest('hex').slice(0, 6);
    return DB_BASE.slice(0, 64 - suffix.length - 7) + '_' + baseDigest + suffix;
}
const DB_NAME = scopedDbName();
const testIndexer = () => ({
    config: {},
    util: {
        sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
        throwError: (message) => { throw new Error(message); },
    },
});
const UTF8 = ' DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci';
const liveColumn = (name, ddl, modify, refuses) => ({ name, ddl, modify, refuses });
const CASES = [
    liveColumn('decimal score rounded to an integer', 'CREATE TABLE guard_probe (value DECIMAL(8,4) NOT NULL DEFAULT 0)',
        'INT NOT NULL DEFAULT 0', /narrows the type \(decimal\(8,4\) -> int\)/),
    liveColumn('microsecond datetime restated bare', 'CREATE TABLE guard_probe (value DATETIME(6) NULL)',
        'DATETIME NULL', /narrows the type \(datetime\(6\) -> datetime\)/),
    liveColumn('datetime truncated to a date', 'CREATE TABLE guard_probe (value DATETIME NULL)',
        'DATE NULL', /narrows the type \(datetime -> date\)/),
    liveColumn('utf8mb4 column restated without a charset in a utf8 table',
        'CREATE TABLE guard_probe (value VARCHAR(250) CHARACTER SET utf8mb4 NOT NULL)' + UTF8,
        'VARCHAR(500) NOT NULL', /omits CHARACTER SET \(utf8mb4_\w+ -> table default utf8mb3_general_ci\)/),
    liveColumn('binary collation restated without COLLATE',
        'CREATE TABLE guard_probe (value VARCHAR(100) CHARACTER SET utf8 COLLATE utf8_bin NOT NULL)' + UTF8,
        'VARCHAR(200) NOT NULL', /omits COLLATE \(utf8mb3_bin -> table default utf8mb3_general_ci\)/),
    liveColumn('timestamp moved to datetime', 'CREATE TABLE guard_probe (value TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP)',
        'DATETIME NULL DEFAULT CURRENT_TIMESTAMP'),
    liveColumn('integer widened to an exact decimal', 'CREATE TABLE guard_probe (value INT NOT NULL)', 'DECIMAL(10,0) NOT NULL'),
    liveColumn('enum extended in a utf8 table', "CREATE TABLE guard_probe (value ENUM('a') NOT NULL)" + UTF8,
        "ENUM('a','b') NOT NULL"),
    liveColumn('utf8mb4 column widened in a utf8mb4 table',
        'CREATE TABLE guard_probe (value VARCHAR(250) NOT NULL) DEFAULT CHARSET=utf8mb4', 'VARCHAR(500) NOT NULL'),
    liveColumn('utf8mb4 column widened with its charset restated',
        'CREATE TABLE guard_probe (value VARCHAR(250) CHARACTER SET utf8mb4 NOT NULL)' + UTF8,
        'VARCHAR(500) CHARACTER SET utf8mb4 NOT NULL'),
];

describe('migration live-schema guard type and charset rules against a real MariaDB @tier3', function () {
    this.timeout(120000);
    let admin = null, db = null;
    before(async function () {
        admin = await mariadb.createConnection({ host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASS });
    });
    after(async function () {
        if (db && db.pool) await db.pool.end();
        if (admin) {
            await admin.query('DROP DATABASE IF EXISTS `' + DB_NAME + '`');
            await admin.end();
        }
    });
    async function withShape(ddl, fn) {
        await admin.query('DROP DATABASE IF EXISTS `' + DB_NAME + '`');
        await admin.query('CREATE DATABASE `' + DB_NAME + '`');
        if (db && db.pool) await db.pool.end();
        db = new Database(DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASS, testIndexer());
        const conn = await db.getConnection();
        try { await conn.query(ddl); return await fn(conn); } finally { await conn.release(); }
    }
    for (const c of CASES) {
        it((c.refuses ? 'refuses: ' : 'allows: ') + c.name + ' from server metadata', async function () {
            const sql = ['ALTER TABLE guard_probe MODIFY COLUMN value ' + c.modify];
            await withShape(c.ddl, async (conn) => {
                const run = () => assertNoLiveColumnLoss(conn, 'server-metadata.sql', sql);
                if (!c.refuses) return run();
                await assert.rejects(run, (err) => {
                    assert.match(err.message, c.refuses);
                    assert.match(err.message, /guard_probe\.value/);
                    return true;
                });
            });
        });
    }
    it('applies every allowed MODIFY on the server without a warning', async function () {
        for (const c of CASES.filter(x => !x.refuses)) {
            await withShape(c.ddl, async (conn) => {
                await conn.query('ALTER TABLE guard_probe MODIFY COLUMN value ' + c.modify);
                const warnings = await conn.query('SHOW WARNINGS');
                assert.deepStrictEqual(Array.from(warnings), [], c.name);
            });
        }
    });
});
