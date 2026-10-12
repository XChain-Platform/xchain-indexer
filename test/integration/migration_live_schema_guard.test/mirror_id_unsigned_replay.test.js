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
 * test/integration/migration_live_schema_guard.test/mirror_id_unsigned_replay.test.js
 *
 * Replays the committed mirror id migrations through the production runner on a database
 * whose ledger predates the unsigned id alignment, so the ids are still signed BIGINT
 * AUTO_INCREMENT. The live-column guard must let the alignment run when no stored id is
 * negative and refuse it, before any DDL or ledger row, when one is.
 *
 * Requires an explicit TEST_DB_* endpoint. Run it with bin/run-db-tiers.sh.
 */

'use strict';
process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';
const assert   = require('assert');
const mariadb  = require('mariadb');
const Database = require('../../../src/db');
// The connection retry backoff the Database constructor is handed, never a test wait.
const { sleep } = require('../../helpers/wait.js');
const DB_HOST = process.env.TEST_DB_HOST || '127.0.0.1';
const DB_PORT = parseInt(process.env.TEST_DB_PORT || '3306');
const DB_USER = process.env.TEST_DB_USER || 'root';
const DB_PASS = process.env.TEST_DB_PASS || '';
const DB_NAME = (process.env.TEST_INDEXER_DB || 'xchain_test_indexer').slice(0, 40) + '_mirror_id_replay';
const REPAIR  = '2026-06-10-mirror-id-autoincrement-repair.sql';
const ALIGN   = '2026-07-16-mirror-id-unsigned-align.sql';
const MIRROR_TABLES = ['price_snapshots', 'cross_chain_matches', 'capability_snapshots', 'state_checkpoints'];
const ALIGNED = ['cross_chain_matches', 'capability_snapshots', 'state_checkpoints'];
const SETTLED = ['bridge_transfers', 'bridge_settlements', 'policy_snapshots', 'xbridges', 'list_snapshots',
    'list_share_mirrors'].map(name => 'CREATE TABLE `' + name + '` (id INT NOT NULL PRIMARY KEY) ENGINE=InnoDB');
const signedTable = (name, extra = ' AUTO_INCREMENT') =>
    'CREATE TABLE `' + name + '` (id BIGINT NOT NULL' + extra + ' PRIMARY KEY) ENGINE=InnoDB';

function testIndexer() {
    return {
        config: {},
        util: {
            sleep,
            throwError: (message) => { throw new Error(message); },
        },
    };
}

let admin = null, db = null;
const withConn = async (fn) => {
    const conn = await db.getConnection();
    try { return await fn(conn); } finally { await conn.release(); }
};
const build = (ddl) => withConn(async (conn) => { for (const stmt of ddl) await conn.query(stmt); });
const ledger = () => withConn(async (conn) => {
    await db.ensureMigrationsLedger(conn);
    return (await conn.query('SELECT name FROM schema_migrations ORDER BY name')).map(r => r.name);
});
const idColumns = () => withConn(conn => conn.query(
    "SELECT TABLE_NAME AS name, COLUMN_TYPE AS type, EXTRA AS extra FROM information_schema.COLUMNS " +
    "WHERE TABLE_SCHEMA = ? AND COLUMN_NAME = 'id' AND TABLE_NAME IN (?, ?, ?)", [DB_NAME].concat(ALIGNED)));
const seed = (ids) => build(ALIGNED.map(name => 'INSERT INTO `' + name + '` (id) VALUES ' +
    ids.map(id => '(' + id + ')').join(', ')));

// Every aligned id is unsigned BIGINT AUTO_INCREMENT and still holds the seeded rows.
async function assertAligned() {
    const cols = await idColumns();
    assert.strictEqual(cols.length, ALIGNED.length);
    for (const col of cols) {
        assert.match(String(col.type), /^bigint\(20\) unsigned$/, col.name + ' id must be unsigned');
        assert.match(String(col.extra), /auto_increment/, col.name + ' id must keep AUTO_INCREMENT');
    }
    for (const name of ALIGNED) {
        const rows = await withConn(conn => conn.query('SELECT id FROM `' + name + '` ORDER BY id'));
        assert.deepStrictEqual(rows.map(r => Number(r.id)), [1, 2, 3], name + ' rows must survive');
    }
}

describe('mirror id unsigned alignment replayed on signed ids @tier3', function () {
    this.timeout(120000);
    before(async function () {
        admin = await mariadb.createConnection({ host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASS });
    });
    beforeEach(async function () {
        await admin.query('DROP DATABASE IF EXISTS `' + DB_NAME + '`');
        await admin.query('CREATE DATABASE `' + DB_NAME + '`');
        if (db && db.pool) await db.pool.end();
        db = new Database(DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASS, testIndexer());
    });
    after(async function () {
        if (db && db.pool) await db.pool.end();
        if (admin) {
            await admin.query('DROP DATABASE IF EXISTS `' + DB_NAME + '`');
            await admin.end();
        }
    });

    it('applies the alignment after a baselined repair when every id is positive', async function () {
        await build(SETTLED.concat(MIRROR_TABLES.map(name => signedTable(name))));
        await seed([1, 2, 3]);
        const result = await db.runMigrations({ only: [REPAIR, ALIGN] });
        assert.deepStrictEqual(result.baselined, [REPAIR]);
        assert.deepStrictEqual(result.applied, [ALIGN]);
        assert.deepStrictEqual(await ledger(), [REPAIR, ALIGN]);
        await assertAligned();
    });

    it('applies the repair and then the alignment when one id lacks AUTO_INCREMENT', async function () {
        await build(SETTLED.concat(MIRROR_TABLES.map(name =>
            signedTable(name, name === 'state_checkpoints' ? '' : ' AUTO_INCREMENT'))));
        await seed([1, 2, 3]);
        const result = await db.runMigrations({ only: [REPAIR, ALIGN] });
        assert.deepStrictEqual(result.applied, [REPAIR, ALIGN]);
        assert.deepStrictEqual(await ledger(), [REPAIR, ALIGN]);
        await assertAligned();
    });

    it('refuses the alignment before any DDL when a stored id is negative', async function () {
        await build(SETTLED.concat(MIRROR_TABLES.map(name => signedTable(name))));
        await build(['INSERT INTO cross_chain_matches (id) VALUES (-5), (1)']);
        await assert.rejects(() => db.runMigrations({ only: [REPAIR, ALIGN] }),
            /cross_chain_matches\.id[\s\S]*narrows the type \(bigint -> bigint unsigned\), live MIN\(id\) is -5/);
        assert.ok(!(await ledger()).includes(ALIGN), 'the refused alignment must not be recorded');
        const cols = await idColumns();
        assert.ok(cols.every(col => /^bigint\(20\)$/.test(String(col.type))), 'every id must stay signed');
    });
});
