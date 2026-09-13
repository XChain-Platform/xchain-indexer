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
 * test/integration/markets-native-coin-migration.test.js
 *
 * Drives 2026-09-10-markets-native-coin-side.sql against a REAL MariaDB.
 *
 * Why this cannot be a stubbed tier: every claim the migration makes is a claim
 * about what the SERVER does. That a surviving row keeps its id and its stored
 * orientation, that NULL is distinct inside uq_markets_pair (so the normalize
 * would collide were the surplus row still there), that the anti-join skips a
 * pair which already has a row in EITHER orientation, and that a second run is a
 * no-op, are all outside what a doQuery stub can answer. Id stability is the
 * load-bearing one: a replica converges on `markets` through an upsert that can
 * add a row but never remove one, so a migration that re-inserted a pair would
 * leave every replica holding two rows for one market.
 *
 * The table is built from markets.sql and then stripped of coin1_id/coin2_id, so
 * the fixture is the shape a live database actually has before the migration.
 *
 * Self-skips when TEST_DB_PASS is unset, matching the other DB-backed files here.
 * Run it with bin/run-db-tiers.sh.
 */

'use strict';

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert  = require('assert');
const fs      = require('fs');
const path    = require('path');
const mariadb = require('mariadb');

const Database = require('../../src/db');

// Credentials and the schema name come from the shared harness. The name is
// derived from the indexer base, never invented: on the gate that base carries the
// ci_ prefix the CI user is granted on, and a schema outside it is created and then
// refused (error 1142) at the first CREATE INDEX.
const dbc = require('./setup/db-connection');
const { DB_HOST, DB_PORT, DB_USER, DB_PASS } = dbc;   // empty DB_PASS => self-skip
const DB_NAME = process.env.TEST_MARKETS_MIGRATION_DB
    || dbc.scopedDbName(dbc.INDEXER_DB, dbc.fileKey(__filename));

const SQL_DIR = path.join(__dirname, '../../src/sql');
const MIGRATION = path.join(SQL_DIR, 'migrations', '2026-09-10-markets-native-coin-side.sql');

// The product's own stripper: the licence banner opens `--***` with no whitespace,
// which MySQL does not read as a comment, so a verbatim send is errno 1064.
const stripSqlLineComments = Database.prototype.stripSqlLineComments;
const SCHEMA = ['markets.sql', 'orders.sql', 'order_matches.sql']
    .map(f => stripSqlLineComments(fs.readFileSync(path.join(SQL_DIR, f), 'utf8')))
    .join('\n');

// The same header-aware split runMigrations applies to the file.
const STATEMENTS = Database.prototype.splitSqlStatements
    .call(Database.prototype, fs.readFileSync(MIGRATION, 'utf8'))
    .map(s => String(s).trim()).filter(Boolean);

const COIN    = 1;      // index_coins id of the chain's own coin
const TOKEN_A = 5;      // the token of the pair that already has a row
const TOKEN_B = 9;      // the token of the pair whose row a reorg sweep destroyed

describe('markets native-coin migration against a real MariaDB @tier3', function () {
    this.timeout(60000);

    let conn;

    before(async function () {
        if (!DB_PASS) this.skip();
        const admin = await mariadb.createConnection({
            host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASS, multipleStatements: true });
        await admin.query('DROP DATABASE IF EXISTS ' + DB_NAME + '; CREATE DATABASE ' + DB_NAME + ';');
        await admin.query('USE ' + DB_NAME + '; ' + SCHEMA);
        await admin.end();
        conn = await mariadb.createConnection({
            host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASS,
            database: DB_NAME, insertIdAsNumber: true, bigIntAsNumber: true });
    });

    after(async function () {
        if (!conn) return;
        await conn.query('DROP DATABASE IF EXISTS ' + DB_NAME);
        await conn.end();
    });

    /** The pre-migration shape: markets.sql declares the two columns, a live DB lacks them. */
    async function seed() {
        await conn.query('DELETE FROM markets');
        await conn.query('DELETE FROM orders');
        await conn.query('DELETE FROM order_matches');
        for (const col of ['coin1_id', 'coin2_id']) {
            try { await conn.query('ALTER TABLE markets DROP COLUMN ' + col); } catch (e) { /* already gone */ }
        }
        await conn.query('ALTER TABLE markets AUTO_INCREMENT = 1');

        // The row a live database holds for TOKEN_A against the coin, stored the way
        // the collector wrote it: the coin side coerced to 0, in ITS orientation.
        await conn.query('INSERT INTO markets (id, tick1_id, tick2_id) VALUES (?, ?, ?)',
            [1, TOKEN_A, 0]);
        // A surplus row for the SAME pair from the NULL era, which the key never bound.
        await conn.query('INSERT INTO markets (id, tick1_id, tick2_id) VALUES (?, ?, NULL)',
            [2, TOKEN_A]);
        // Orders behind that pair, so step 5 can label it.
        await order(10, TOKEN_A, null);
        // The pair whose row the reorg sweep deleted. Its EARLIEST order gives the token
        // and gets the coin, so the row the migration creates must be (0, TOKEN_B).
        await order(20, TOKEN_B, null);
        await order(30, null, TOKEN_B);
    }

    /** One orders row for a same-coin pair. A tickerless side is stored NULL, as the collector does. */
    function order(action_index, give_tick_id, get_tick_id) {
        return conn.query(
            `INSERT INTO orders (action_index, give_coin_id, give_tick_id, get_coin_id, get_tick_id)
             VALUES (?, ?, ?, ?, ?)`,
            [action_index, COIN, give_tick_id, COIN, get_tick_id]);
    }

    async function runMigration() {
        for (const stmt of STATEMENTS) await conn.query(stmt);
    }

    function marketRows() {
        return conn.query('SELECT id, tick1_id, tick2_id, coin1_id, coin2_id FROM markets ORDER BY id');
    }

    it('keeps the surviving row on its own id and orientation, and adds the missing pair', async function () {
        await seed();
        await runMigration();
        const rows = await marketRows();
        assert.strictEqual(rows.length, 2,
            'one row per pair: the surplus NULL-era row goes, the destroyed pair comes back');

        const kept = rows.find(r => r.id === 1);
        assert.ok(kept, 'the lowest id of the duplicated pair must survive, so market_id never moves');
        assert.strictEqual(Number(kept.tick1_id), TOKEN_A, 'the stored orientation must not be rewritten');
        assert.strictEqual(Number(kept.tick2_id), 0);
        assert.strictEqual(Number(kept.coin1_id), COIN);
        assert.strictEqual(Number(kept.coin2_id), COIN);

        const added = rows.find(r => r.id !== 1);
        assert.strictEqual(Number(added.tick1_id), 0,
            'orientation comes from the earliest order: it GETS the coin, so side 1 is the sentinel');
        assert.strictEqual(Number(added.tick2_id), TOKEN_B);
        assert.strictEqual(Number(added.coin1_id), COIN);
        assert.strictEqual(Number(added.coin2_id), COIN);
    });

    it('changes nothing on a second run', async function () {
        await seed();
        await runMigration();
        const first = await marketRows();
        await runMigration();
        const second = await marketRows();
        assert.deepStrictEqual(
            second.map(r => [r.id, Number(r.tick1_id), Number(r.tick2_id), Number(r.coin1_id), Number(r.coin2_id)]),
            first.map(r => [r.id, Number(r.tick1_id), Number(r.tick2_id), Number(r.coin1_id), Number(r.coin2_id)]));
    });

    it('runs clean on a database that already carries the columns', async function () {
        await seed();
        await runMigration();
        const before = await marketRows();
        // A fresh install: the drift reconciler already added the columns from markets.sql.
        await runMigration();
        await runMigration();
        assert.deepStrictEqual((await marketRows()).length, before.length);
    });
});
