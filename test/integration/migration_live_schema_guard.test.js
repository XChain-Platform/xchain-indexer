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
 * test/integration/migration_live_schema_guard.test.js
 *
 * Drives the runner's live-schema precondition guard (MIGRATION_PRECONDITIONS)
 * against a REAL MariaDB.
 *
 * Why this cannot be a stubbed tier: each precondition is an information_schema
 * query plus a predicate over the rows the server returns. A doQuery stub answers
 * with whatever the test author believes information_schema says; only the server
 * can say what CHARACTER_MAXIMUM_LENGTH, statistics.non_unique and table presence
 * actually report for a given DDL shape. The two outcomes are asymmetric and both
 * matter: a false "already converged" answer baselines a migration the database
 * still needs (the ledger then hides the missing change forever), and a false
 * "needs running" answer re-runs a data-rewriting migration on a schema it would
 * damage.
 *
 * Every shape below is built with plain DDL in a scratch schema, so the guard sees
 * exactly what a live database presents: the converged shapes that must be
 * baselined, and every partial or absent shape that must be left to run.
 *
 * Self-skips when no DB password is configured, matching the other DB-backed files
 * here. Run it with bin/run-db-tiers.sh.
 */

'use strict';

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert  = require('assert');
const fs      = require('fs');
const path    = require('path');
const mariadb = require('mariadb');

const Database = require('../../src/db');
const dbc = require('./setup/db-connection');
const { DB_HOST, DB_PORT, DB_USER, DB_PASS } = dbc;   // empty DB_PASS => self-skip

const DB_NAME = dbc.scopedDbName(dbc.INDEXER_DB, dbc.fileKey(__filename));
const MIGRATIONS_DIR = path.join(__dirname, '../../src/sql/migrations');

const PUBKEYS   = '2026-07-24-pubkeys-widen-uncompressed.sql';
const DERIVE    = '2026-08-12-validator-rewards-derive-block-index.sql';
const QUALIFIER = '2026-08-24-validator-rewards-round-qualifier.sql';
const BRIDGE    = '2026-09-12-bridge-tables.sql';
const LISTS     = '2026-09-30-list-share-tables.sql';
const TICK      = '2026-09-22-oracle-prices-widen-tick.sql';

function testIndexer() {
    return {
        config: {},
        util: {
            sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
            throwError: (message) => { throw new Error(message); },
        },
    };
}

const REWARD_TABLE = (extra) =>
    'CREATE TABLE validator_rewards (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, ' +
    'round_id INT NOT NULL, validator VARCHAR(66) NOT NULL' + extra + ') ENGINE=InnoDB';
const LOG_TABLE = (extra) =>
    'CREATE TABLE anchor_reward_reconcile_log (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, ' +
    'note VARCHAR(20) NULL' + extra + ') ENGINE=InnoDB';
const simpleTable = (name) => 'CREATE TABLE `' + name + '` (id INT NOT NULL PRIMARY KEY) ENGINE=InnoDB';

// Each case: the migration it is evaluated for, the DDL that builds the live shape,
// and whether the guard must baseline it (true) or leave it to run (false).
const CASES = [
    { name: 'pubkeys at the full uncompressed width', file: PUBKEYS, baseline: true,
      ddl: ['CREATE TABLE pubkeys (pubkey VARCHAR(130) NOT NULL PRIMARY KEY)'] },
    { name: 'pubkeys wider than the target', file: PUBKEYS, baseline: true,
      ddl: ['CREATE TABLE pubkeys (pubkey VARCHAR(255) NOT NULL PRIMARY KEY)'] },
    { name: 'pubkeys one character short of the target', file: PUBKEYS, baseline: false,
      ddl: ['CREATE TABLE pubkeys (pubkey VARCHAR(129) NOT NULL PRIMARY KEY)'] },
    { name: 'pubkeys still compressed width', file: PUBKEYS, baseline: false,
      ddl: ['CREATE TABLE pubkeys (pubkey VARCHAR(66) NOT NULL PRIMARY KEY)'] },
    { name: 'pubkeys table absent', file: PUBKEYS, baseline: false, ddl: [] },
    { name: 'pubkeys without the pubkey column', file: PUBKEYS, baseline: false,
      ddl: ['CREATE TABLE pubkeys (other VARCHAR(130) NOT NULL PRIMARY KEY)'] },

    { name: 'oracle tick at the target width', file: TICK, baseline: true,
      ddl: ['CREATE TABLE oracle_prices (id INT NOT NULL PRIMARY KEY, tick VARCHAR(250) NOT NULL)'] },
    { name: 'oracle tick still narrow', file: TICK, baseline: false,
      ddl: ['CREATE TABLE oracle_prices (id INT NOT NULL PRIMARY KEY, tick VARCHAR(249) NOT NULL)'] },
    { name: 'oracle_prices table absent', file: TICK, baseline: false, ddl: [] },

    { name: 'derive-block columns and index all present', file: DERIVE, baseline: true,
      ddl: [REWARD_TABLE(', derive_block_index INT NULL, KEY idx_derive (derive_block_index)'),
            LOG_TABLE(', reward_derive_block_index INT NULL')] },
    { name: 'derive-block index missing', file: DERIVE, baseline: false,
      ddl: [REWARD_TABLE(', derive_block_index INT NULL'),
            LOG_TABLE(', reward_derive_block_index INT NULL')] },
    { name: 'derive-block log column missing', file: DERIVE, baseline: false,
      ddl: [REWARD_TABLE(', derive_block_index INT NULL, KEY idx_derive (derive_block_index)'), LOG_TABLE('')] },
    { name: 'derive-block reward column missing', file: DERIVE, baseline: false,
      ddl: [REWARD_TABLE(''), LOG_TABLE(', reward_derive_block_index INT NULL')] },
    { name: 'derive-block tables absent', file: DERIVE, baseline: false, ddl: [] },

    { name: 'qualifier columns present and reward_unique carries it', file: QUALIFIER, baseline: true,
      ddl: [REWARD_TABLE(", round_qualifier VARCHAR(20) NOT NULL DEFAULT '', " +
                         'UNIQUE KEY reward_unique (round_id, validator, round_qualifier)'),
            LOG_TABLE(", round_qualifier VARCHAR(20) NOT NULL DEFAULT ''")] },
    { name: 'qualifier columns present but reward_unique still four-column', file: QUALIFIER, baseline: false,
      ddl: [REWARD_TABLE(", round_qualifier VARCHAR(20) NOT NULL DEFAULT '', " +
                         'UNIQUE KEY reward_unique (round_id, validator)'),
            LOG_TABLE(", round_qualifier VARCHAR(20) NOT NULL DEFAULT ''")] },
    { name: 'qualifier in a same-named NON-unique index', file: QUALIFIER, baseline: false,
      ddl: [REWARD_TABLE(", round_qualifier VARCHAR(20) NOT NULL DEFAULT '', " +
                         'KEY reward_unique (round_id, validator, round_qualifier)'),
            LOG_TABLE(", round_qualifier VARCHAR(20) NOT NULL DEFAULT ''")] },
    { name: 'qualifier in a differently named unique index', file: QUALIFIER, baseline: false,
      ddl: [REWARD_TABLE(", round_qualifier VARCHAR(20) NOT NULL DEFAULT '', " +
                         'UNIQUE KEY other_unique (round_id, validator, round_qualifier)'),
            LOG_TABLE(", round_qualifier VARCHAR(20) NOT NULL DEFAULT ''")] },
    { name: 'qualifier log column missing', file: QUALIFIER, baseline: false,
      ddl: [REWARD_TABLE(", round_qualifier VARCHAR(20) NOT NULL DEFAULT '', " +
                         'UNIQUE KEY reward_unique (round_id, validator, round_qualifier)'),
            LOG_TABLE('')] },
    { name: 'qualifier tables absent', file: QUALIFIER, baseline: false, ddl: [] },

    { name: 'all four bridge tables present', file: BRIDGE, baseline: true,
      ddl: ['bridge_transfers', 'bridge_settlements', 'policy_snapshots', 'xbridges'].map(simpleTable) },
    { name: 'three of four bridge tables present', file: BRIDGE, baseline: false,
      ddl: ['bridge_transfers', 'bridge_settlements', 'policy_snapshots'].map(simpleTable) },
    { name: 'no bridge tables', file: BRIDGE, baseline: false, ddl: [] },

    { name: 'both list share tables present', file: LISTS, baseline: true,
      ddl: ['list_snapshots', 'list_share_mirrors'].map(simpleTable) },
    { name: 'only one list share table present', file: LISTS, baseline: false,
      ddl: ['list_snapshots'].map(simpleTable) },
    { name: 'no list share tables', file: LISTS, baseline: false, ddl: [] },
];

const BRIDGE_TABLES = ['bridge_transfers', 'bridge_settlements', 'policy_snapshots', 'xbridges'];
const LIST_TABLES = ['list_snapshots', 'list_share_mirrors'];
const QUALIFIED = REWARD_TABLE(", round_qualifier VARCHAR(20) NOT NULL DEFAULT '', " +
                               'UNIQUE KEY reward_unique (round_id, validator, round_qualifier)');
const UTF8 = ' ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci';

const ASSERTIONS = [
    { name: 'pubkeys.pubkey narrower than an uncompressed key', method: 'assertPubkeyColumnIsUncompressedWide',
      ddl: ['CREATE TABLE pubkeys (pubkey VARCHAR(66) NOT NULL PRIMARY KEY)'],
      refuses: /holds 66 chars but VARCHAR\(130\)[\s\S]*--file 2026-07-24-pubkeys-widen-uncompressed\.sql/ },
    { name: 'pubkeys.pubkey one character short', method: 'assertPubkeyColumnIsUncompressedWide',
      ddl: ['CREATE TABLE pubkeys (pubkey VARCHAR(129) NOT NULL PRIMARY KEY)'], refuses: /holds 129 chars/ },
    { name: 'pubkeys.pubkey at the required width', method: 'assertPubkeyColumnIsUncompressedWide',
      ddl: ['CREATE TABLE pubkeys (pubkey VARCHAR(130) NOT NULL PRIMARY KEY)'] },
    { name: 'pubkeys.pubkey wider than required', method: 'assertPubkeyColumnIsUncompressedWide',
      ddl: ['CREATE TABLE pubkeys (pubkey VARCHAR(255) NOT NULL PRIMARY KEY)'] },
    { name: 'pubkeys table absent', method: 'assertPubkeyColumnIsUncompressedWide', ddl: [] },
    { name: 'pubkeys.pubkey of a non-character type', method: 'assertPubkeyColumnIsUncompressedWide',
      ddl: ['CREATE TABLE pubkeys (pubkey INT NOT NULL PRIMARY KEY)'] },

    { name: 'validator_rewards without round_qualifier', method: 'assertRewardUniqueKeyCarriesQualifier',
      ddl: [REWARD_TABLE(', UNIQUE KEY reward_unique (round_id, validator)')],
      refuses: /no round_qualifier column[\s\S]*--file 2026-08-24-validator-rewards-round-qualifier\.sql/ },
    { name: 'reward_unique still four-column', method: 'assertRewardUniqueKeyCarriesQualifier',
      ddl: [REWARD_TABLE(", round_qualifier VARCHAR(20) NOT NULL DEFAULT '', UNIQUE KEY reward_unique (round_id, validator)")],
      refuses: /reward_unique does not include round_qualifier/ },
    { name: 'round_qualifier only in a non-unique reward_unique', method: 'assertRewardUniqueKeyCarriesQualifier',
      ddl: [REWARD_TABLE(", round_qualifier VARCHAR(20) NOT NULL DEFAULT '', KEY reward_unique (round_id, validator, round_qualifier)")],
      refuses: /reward_unique does not include round_qualifier/ },
    { name: 'reward_unique carries round_qualifier', method: 'assertRewardUniqueKeyCarriesQualifier', ddl: [QUALIFIED] },
    { name: 'validator_rewards absent', method: 'assertRewardUniqueKeyCarriesQualifier', ddl: [] },
    { name: 'qualifier column present with no reward_unique index', method: 'assertRewardUniqueKeyCarriesQualifier',
      ddl: [REWARD_TABLE(", round_qualifier VARCHAR(20) NOT NULL DEFAULT ''")] },

    { name: 'every bridge table absent', method: 'assertBridgeTablesPresent', ddl: [],
      refuses: /bridge tables bridge_transfers, bridge_settlements, policy_snapshots, xbridges are absent[\s\S]*--file 2026-09-12-bridge-tables\.sql/ },
    { name: 'only xbridges absent', method: 'assertBridgeTablesPresent',
      ddl: BRIDGE_TABLES.slice(0, 3).map(simpleTable), refuses: /bridge tables xbridges are absent/ },
    { name: 'all four bridge tables present', method: 'assertBridgeTablesPresent', ddl: BRIDGE_TABLES.map(simpleTable) },

    { name: 'both list share tables absent', method: 'assertListShareTablesPresent', ddl: [],
      refuses: /shared-list tables list_snapshots, list_share_mirrors are absent[\s\S]*--file 2026-09-30-list-share-tables\.sql/ },
    { name: 'list_share_mirrors absent', method: 'assertListShareTablesPresent',
      ddl: [simpleTable('list_snapshots')], refuses: /shared-list tables list_share_mirrors are absent/ },
    { name: 'both list share tables present', method: 'assertListShareTablesPresent', ddl: LIST_TABLES.map(simpleTable) },

    { name: 'index_addresses.address drifted to utf8mb4', method: 'assertStakeWeightOrderingCollation',
      ddl: ['CREATE TABLE index_addresses (address VARCHAR(120) NOT NULL PRIMARY KEY) ENGINE=InnoDB ' +
            'DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci'],
      refuses: /index_addresses\.address is utf8mb4 \/ utf8mb4_general_ci but src\/sql declares utf8 \/ utf8_general_ci/ },
    { name: 'index_pubkeys.pubkey drifted to a binary collation', method: 'assertStakeWeightOrderingCollation',
      ddl: ['CREATE TABLE index_pubkeys (pubkey CHAR(64) NOT NULL PRIMARY KEY) ENGINE=InnoDB ' +
            'DEFAULT CHARSET=utf8 COLLATE=utf8_bin'],
      refuses: /index_pubkeys\.pubkey is utf8 \/ utf8_bin/ },
    { name: 'both ordering columns on the declared utf8 collation', method: 'assertStakeWeightOrderingCollation',
      ddl: ['CREATE TABLE index_addresses (address VARCHAR(120) NOT NULL PRIMARY KEY)' + UTF8,
            'CREATE TABLE index_pubkeys (pubkey CHAR(64) NOT NULL PRIMARY KEY)' + UTF8] },
    { name: 'ordering tables absent', method: 'assertStakeWeightOrderingCollation', ddl: [] },
];

const SETTLED = BRIDGE_TABLES.concat(LIST_TABLES).map(simpleTable);
const NARROW_TICK = 'CREATE TABLE oracle_prices (id INT NOT NULL PRIMARY KEY, tick VARCHAR(100) NOT NULL)';

// The scratch schema and the helpers that act on it, shared by every suite below.
function schemaHarness() {
    const h = { admin: null, db: null };

    h.reset = async () => {
        await h.admin.query('DROP DATABASE IF EXISTS `' + DB_NAME + '`');
        await h.admin.query('CREATE DATABASE `' + DB_NAME + '`');
        if (h.db && h.db.pool) await h.db.pool.end();
        h.db = new Database(DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASS, testIndexer());
    };
    h.withConn = async (fn) => {
        const conn = await h.db.getConnection();
        try { return await fn(conn); } finally { await conn.release(); }
    };
    h.build = (ddl) => h.withConn(async (conn) => { for (const stmt of ddl) await conn.query(stmt); });
    h.ledger = () => h.withConn(async (conn) => {
        await h.db.ensureMigrationsLedger(conn);
        return conn.query('SELECT name, mode FROM schema_migrations ORDER BY name');
    });
    h.tickWidth = () => h.withConn(async (conn) => {
        const cols = await conn.query(
            'SELECT CHARACTER_MAXIMUM_LENGTH AS len FROM information_schema.columns ' +
            "WHERE table_schema = ? AND table_name = 'oracle_prices' AND column_name = 'tick'", [DB_NAME]);
        return Number(cols[0].len);
    });

    before(async function () {
        if (!DB_PASS) this.skip();
        h.admin = await mariadb.createConnection({
            host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASS,
        });
    });
    after(async function () {
        if (h.db && h.db.pool) await h.db.pool.end();
        if (h.admin) {
            await h.admin.query('DROP DATABASE IF EXISTS `' + DB_NAME + '`');
            await h.admin.end();
        }
    });
    return h;
}

function defineCoverage() {
    it('covers every declared precondition with at least one baselined and one refused shape', function () {
        const declared = Object.keys(Database.MIGRATION_PRECONDITIONS).sort();
        assert.deepStrictEqual([...new Set(CASES.map(c => c.file))].sort(), declared);
        for (const file of declared) {
            assert.ok(fs.existsSync(path.join(MIGRATIONS_DIR, file)), file + ' must be a committed migration');
            assert.ok(CASES.some(c => c.file === file && c.baseline), file + ' needs a converged shape');
            assert.ok(CASES.some(c => c.file === file && !c.baseline), file + ' needs a not-converged shape');
        }
    });

    it('names a refusal class and an allowed shape for every registered startup assertion', function () {
        for (const { assertion } of Database.STARTUP_ASSERTED_MIGRATIONS) {
            assert.ok(ASSERTIONS.some(c => c.method === assertion && c.refuses), assertion + ' needs a refused shape');
            assert.ok(ASSERTIONS.some(c => c.method === assertion && !c.refuses), assertion + ' needs an allowed shape');
        }
    });
}

function defineVerdicts(h) {
    for (const c of CASES) {
        it((c.baseline ? 'baselines: ' : 'leaves to run: ') + c.name + ' (' + c.file + ')', async function () {
            await h.reset();
            await h.build(c.ddl);
            const reason = await h.withConn(conn => h.db.migrationPreconditionSkip(c.file, conn));
            if (c.baseline) {
                assert.strictEqual(typeof reason, 'string', 'a converged shape must be reported as not applicable');
                assert.ok(reason.length > 0);
            } else {
                assert.strictEqual(reason, null, 'a shape that still needs the migration must not be baselined');
            }
        });
    }
}

function defineAssertions(h) {
    for (const c of ASSERTIONS) {
        it((c.refuses ? 'refuses: ' : 'allows: ') + c.name + ' (' + c.method + ')', async function () {
            await h.reset();
            await h.build(c.ddl);
            const run = () => Database.prototype[c.method].call(h.db);
            if (c.refuses) {
                await assert.rejects(run, (err) => { assert.match(err.message, c.refuses); return true; });
            } else {
                await run();
            }
        });
    }
}

function defineRunner(h) {
    beforeEach(() => h.reset());

    it('baselines a converged manual migration without running it, even on a passive start', async function () {
        await h.build(SETTLED.concat([
            'CREATE TABLE oracle_prices (id INT NOT NULL PRIMARY KEY, tick VARCHAR(250) NOT NULL)',
            "INSERT INTO oracle_prices (id, tick) VALUES (1, 'kept')"]));
        const result = await h.db.runMigrations({ only: [TICK] });
        assert.deepStrictEqual(result.baselined, [TICK]);
        assert.deepStrictEqual(result.applied, []);
        assert.deepStrictEqual(result.pending, []);
        assert.deepStrictEqual((await h.ledger()).map(r => r.name), [TICK]);
        const rows = await h.withConn(conn => conn.query('SELECT tick FROM oracle_prices'));
        assert.deepStrictEqual(rows.map(r => r.tick), ['kept']);

        const again = await h.db.runMigrations({ only: [TICK] });
        assert.deepStrictEqual(again.baselined.concat(again.applied, again.pending), []);
    });

    it('keeps a not-converged manual migration pending on a passive start', async function () {
        await h.build(SETTLED.concat([NARROW_TICK]));
        const result = await h.db.runMigrations({ only: [TICK] });
        assert.deepStrictEqual(result.pending, [TICK]);
        assert.deepStrictEqual(result.baselined.concat(result.applied), []);
        assert.deepStrictEqual(await h.ledger(), []);
        assert.strictEqual(await h.tickWidth(), 100);
    });

    it('applies a not-converged manual migration only on the operator path', async function () {
        await h.build(SETTLED.concat([NARROW_TICK]));
        const result = await h.db.runMigrations({ only: [TICK], includeManual: true });
        assert.deepStrictEqual(result.applied, [TICK]);
        assert.deepStrictEqual(result.baselined, []);
        assert.strictEqual(await h.tickWidth(), 250);
        assert.deepStrictEqual((await h.ledger()).map(r => r.name), [TICK]);
    });

    it('does not baseline a half-converged reward key, and the run halts on it', async function () {
        await h.build(SETTLED.concat([
            REWARD_TABLE(", round_qualifier VARCHAR(20) NOT NULL DEFAULT '', UNIQUE KEY reward_unique (round_id, validator)"),
            LOG_TABLE(", round_qualifier VARCHAR(20) NOT NULL DEFAULT ''"),
        ]));
        await assert.rejects(() => h.db.runMigrations({ only: [QUALIFIER] }),
            /reward_unique does not include round_qualifier/);
        assert.deepStrictEqual(await h.ledger(), [], 'the half-converged key must not be recorded as applied');
    });

    it('halts a run whose schema lacks a registered precondition table', async function () {
        await h.build(SETTLED.filter(sql => !sql.includes('xbridges')));
        await assert.rejects(() => h.db.runMigrations({ only: [TICK] }), /bridge tables xbridges are absent/);
    });
}

describe('migration live-schema guard against a real MariaDB @tier3', function () {
    this.timeout(120000);
    const h = schemaHarness();

    defineCoverage();
    describe('precondition verdict per live shape', () => defineVerdicts(h));
    describe('startup assertions refuse a drifted live schema', () => defineAssertions(h));
    describe('through the production runner', () => defineRunner(h));
});
