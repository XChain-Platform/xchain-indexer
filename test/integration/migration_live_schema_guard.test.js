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
 * Drives migration preconditions, startup assertions and lossy-MODIFY detection
 * against server-produced MariaDB metadata. Each case builds its shape with DDL
 * so the test can distinguish a safely converged migration from partial drift.
 *
 * Requires an explicit TEST_DB_* endpoint. Run it with bin/run-db-tiers.sh.
 */

'use strict';
process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';
const assert  = require('assert');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');
const mariadb = require('mariadb');
const Database = require('../../src/db');
const { assertNoLiveColumnLoss } = require('../../src/db/database/migration_live_schema_guard.js');
const DB_HOST = process.env.TEST_DB_HOST || '127.0.0.1';
const DB_PORT = parseInt(process.env.TEST_DB_PORT || '3306');
const DB_USER = process.env.TEST_DB_USER || 'root';
const DB_PASS = process.env.TEST_DB_PASS || '';
const DB_BASE = process.env.TEST_INDEXER_DB || 'xchain_test_indexer';
function scopedDbName() {
    const suffix = '_migration_guard_' + crypto.createHash('sha1')
        .update(__filename).digest('hex').slice(0, 6);
    if (DB_BASE.length + suffix.length <= 64) return DB_BASE + suffix;
    const baseDigest = crypto.createHash('sha1').update(DB_BASE).digest('hex').slice(0, 6);
    return DB_BASE.slice(0, 64 - suffix.length - 7) + '_' + baseDigest + suffix;
}
const DB_NAME = scopedDbName();
const MIGRATIONS_DIR = path.join(__dirname, '../../src/sql/migrations');
const MIRROR    = '2026-06-10-mirror-id-autoincrement-repair.sql';
const PUBKEYS   = '2026-07-24-pubkeys-widen-uncompressed.sql';
const DERIVE    = '2026-08-12-validator-rewards-derive-block-index.sql';
const QUALIFIER = '2026-08-24-validator-rewards-round-qualifier.sql';
const BRIDGE    = '2026-09-12-bridge-tables.sql';
const LISTS     = '2026-09-30-list-share-tables.sql';
const TICK      = '2026-09-22-oracle-prices-widen-tick.sql';
const NULLABLE  = '2026-07-05-contract-index-columns-nullable.sql';
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
const MIRROR_TABLES = ['price_snapshots', 'cross_chain_matches', 'capability_snapshots', 'state_checkpoints'];
const BRIDGE_TABLES = ['bridge_transfers', 'bridge_settlements', 'policy_snapshots', 'xbridges'];
const LIST_TABLES = ['list_snapshots', 'list_share_mirrors'];
const mirrorTable = (name, type = 'BIGINT', extra = ' AUTO_INCREMENT') =>
    'CREATE TABLE `' + name + '` (id ' + type + ' NOT NULL' + extra + ' PRIMARY KEY) ENGINE=InnoDB';
const shape = (name, file, baseline, ...ddl) => ({ name, file, baseline, ddl: ddl.flat() });
// Each case: the migration it is evaluated for, the DDL that builds the live shape,
// and whether the guard must baseline it (true) or leave it to run (false).
const CASES = [
    shape('all mirror ids carry BIGINT AUTO_INCREMENT', MIRROR, true, MIRROR_TABLES.map(name => mirrorTable(name))),
    shape('one mirror id lacks AUTO_INCREMENT', MIRROR, false, MIRROR_TABLES.map(name =>
        mirrorTable(name, 'BIGINT', name === 'state_checkpoints' ? '' : ' AUTO_INCREMENT'))),
    shape('one mirror id is not BIGINT', MIRROR, false, MIRROR_TABLES.map(name =>
        mirrorTable(name, name === 'state_checkpoints' ? 'INT' : 'BIGINT'))),
    shape('one mirror table is absent', MIRROR, false, MIRROR_TABLES.slice(0, 3).map(name => mirrorTable(name))),
    shape('all mirror tables are absent', MIRROR, false),
    shape('pubkeys at the full uncompressed width', PUBKEYS, true, 'CREATE TABLE pubkeys (pubkey VARCHAR(130) NOT NULL PRIMARY KEY)'),
    shape('pubkeys wider than the target', PUBKEYS, true, 'CREATE TABLE pubkeys (pubkey VARCHAR(255) NOT NULL PRIMARY KEY)'),
    shape('pubkeys one character short of the target', PUBKEYS, false, 'CREATE TABLE pubkeys (pubkey VARCHAR(129) NOT NULL PRIMARY KEY)'),
    shape('pubkeys still compressed width', PUBKEYS, false, 'CREATE TABLE pubkeys (pubkey VARCHAR(66) NOT NULL PRIMARY KEY)'),
    shape('pubkeys table absent', PUBKEYS, false),
    shape('pubkeys without the pubkey column', PUBKEYS, false, 'CREATE TABLE pubkeys (other VARCHAR(130) NOT NULL PRIMARY KEY)'),
    shape('oracle tick at the target width', TICK, true, 'CREATE TABLE oracle_prices (id INT NOT NULL PRIMARY KEY, tick VARCHAR(250) NOT NULL)'),
    shape('oracle tick still narrow', TICK, false, 'CREATE TABLE oracle_prices (id INT NOT NULL PRIMARY KEY, tick VARCHAR(249) NOT NULL)'),
    shape('oracle_prices table absent', TICK, false),
    shape('derive-block columns and index all present', DERIVE, true, REWARD_TABLE(', derive_block_index INT NULL, KEY idx_derive (derive_block_index)'),
        LOG_TABLE(', reward_derive_block_index INT NULL')),
    shape('derive-block index missing', DERIVE, false, REWARD_TABLE(', derive_block_index INT NULL'),
        LOG_TABLE(', reward_derive_block_index INT NULL')),
    shape('derive-block log column missing', DERIVE, false, REWARD_TABLE(', derive_block_index INT NULL, KEY idx_derive (derive_block_index)'), LOG_TABLE('')),
    shape('derive-block reward column missing', DERIVE, false, REWARD_TABLE(''), LOG_TABLE(', reward_derive_block_index INT NULL')),
    shape('derive-block tables absent', DERIVE, false),
    shape('qualifier columns present and reward_unique carries it', QUALIFIER, true, REWARD_TABLE(", round_qualifier VARCHAR(20) NOT NULL DEFAULT '', UNIQUE KEY reward_unique " +
            '(round_id, validator, round_qualifier)'), LOG_TABLE(", round_qualifier VARCHAR(20) NOT NULL DEFAULT ''")),
    shape('qualifier columns present but reward_unique still four-column', QUALIFIER, false, REWARD_TABLE(", round_qualifier VARCHAR(20) NOT NULL DEFAULT '', UNIQUE KEY reward_unique (round_id, validator)"),
        LOG_TABLE(", round_qualifier VARCHAR(20) NOT NULL DEFAULT ''")),
    shape('qualifier in a same-named NON-unique index', QUALIFIER, false, REWARD_TABLE(", round_qualifier VARCHAR(20) NOT NULL DEFAULT '', KEY reward_unique " +
            '(round_id, validator, round_qualifier)'), LOG_TABLE(", round_qualifier VARCHAR(20) NOT NULL DEFAULT ''")),
    shape('qualifier in a differently named unique index', QUALIFIER, false, REWARD_TABLE(", round_qualifier VARCHAR(20) NOT NULL DEFAULT '', UNIQUE KEY other_unique " +
            '(round_id, validator, round_qualifier)'), LOG_TABLE(", round_qualifier VARCHAR(20) NOT NULL DEFAULT ''")),
    shape('qualifier log column missing', QUALIFIER, false, REWARD_TABLE(", round_qualifier VARCHAR(20) NOT NULL DEFAULT '', UNIQUE KEY reward_unique " +
            '(round_id, validator, round_qualifier)'), LOG_TABLE('')),
    shape('qualifier tables absent', QUALIFIER, false),
    shape('all four bridge tables present', BRIDGE, true, BRIDGE_TABLES.map(simpleTable)),
    shape('three of four bridge tables present', BRIDGE, false, BRIDGE_TABLES.slice(0, 3).map(simpleTable)),
    shape('no bridge tables', BRIDGE, false),
    shape('both list share tables present', LISTS, true, LIST_TABLES.map(simpleTable)),
    shape('only one list share table present', LISTS, false, simpleTable('list_snapshots')),
    shape('no list share tables', LISTS, false),
];
const QUALIFIED = REWARD_TABLE(", round_qualifier VARCHAR(20) NOT NULL DEFAULT '', " +
                               'UNIQUE KEY reward_unique (round_id, validator, round_qualifier)');
const UTF8 = ' ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci';
const assertion = (name, method, refuses, ...ddl) => ({ name, method, refuses, ddl: ddl.flat() });
const ASSERTIONS = [
    assertion('pubkeys.pubkey narrower than an uncompressed key', 'assertPubkeyColumnIsUncompressedWide', /holds 66 chars but VARCHAR\(130\)[\s\S]*--file 2026-07-24-pubkeys-widen-uncompressed\.sql/,
        'CREATE TABLE pubkeys (pubkey VARCHAR(66) NOT NULL PRIMARY KEY)'),
    assertion('pubkeys.pubkey one character short', 'assertPubkeyColumnIsUncompressedWide', /holds 129 chars/,
        'CREATE TABLE pubkeys (pubkey VARCHAR(129) NOT NULL PRIMARY KEY)'),
    assertion('pubkeys.pubkey at the required width', 'assertPubkeyColumnIsUncompressedWide', undefined,
        'CREATE TABLE pubkeys (pubkey VARCHAR(130) NOT NULL PRIMARY KEY)'),
    assertion('pubkeys.pubkey wider than required', 'assertPubkeyColumnIsUncompressedWide', undefined,
        'CREATE TABLE pubkeys (pubkey VARCHAR(255) NOT NULL PRIMARY KEY)'),
    assertion('pubkeys table absent', 'assertPubkeyColumnIsUncompressedWide'),
    assertion('pubkeys.pubkey of a non-character type', 'assertPubkeyColumnIsUncompressedWide', undefined,
        'CREATE TABLE pubkeys (pubkey INT NOT NULL PRIMARY KEY)'),
    assertion('validator_rewards without round_qualifier', 'assertRewardUniqueKeyCarriesQualifier', /no round_qualifier column[\s\S]*--file 2026-08-24-validator-rewards-round-qualifier\.sql/,
        REWARD_TABLE(', UNIQUE KEY reward_unique (round_id, validator)')),
    assertion('reward_unique still four-column', 'assertRewardUniqueKeyCarriesQualifier', /reward_unique does not include round_qualifier/,
        REWARD_TABLE(", round_qualifier VARCHAR(20) NOT NULL DEFAULT '', UNIQUE KEY reward_unique (round_id, validator)")),
    assertion('round_qualifier only in a non-unique reward_unique', 'assertRewardUniqueKeyCarriesQualifier', /reward_unique does not include round_qualifier/,
        REWARD_TABLE(", round_qualifier VARCHAR(20) NOT NULL DEFAULT '', KEY reward_unique (round_id, validator, round_qualifier)")),
    assertion('reward_unique carries round_qualifier', 'assertRewardUniqueKeyCarriesQualifier', undefined, QUALIFIED),
    assertion('validator_rewards absent', 'assertRewardUniqueKeyCarriesQualifier'),
    assertion('qualifier column present with no reward_unique index', 'assertRewardUniqueKeyCarriesQualifier', undefined,
        REWARD_TABLE(", round_qualifier VARCHAR(20) NOT NULL DEFAULT ''")),
    assertion('every bridge table absent', 'assertBridgeTablesPresent', /bridge tables bridge_transfers, bridge_settlements, policy_snapshots, xbridges are absent[\s\S]*--file 2026-09-12-bridge-tables\.sql/),
    assertion('only xbridges absent', 'assertBridgeTablesPresent', /bridge tables xbridges are absent/,
        BRIDGE_TABLES.slice(0, 3).map(simpleTable)),
    assertion('all four bridge tables present', 'assertBridgeTablesPresent', undefined, BRIDGE_TABLES.map(simpleTable)),
    assertion('both list share tables absent', 'assertListShareTablesPresent', /shared-list tables list_snapshots, list_share_mirrors are absent[\s\S]*--file 2026-09-30-list-share-tables\.sql/),
    assertion('list_share_mirrors absent', 'assertListShareTablesPresent', /shared-list tables list_share_mirrors are absent/, simpleTable('list_snapshots')),
    assertion('both list share tables present', 'assertListShareTablesPresent', undefined, LIST_TABLES.map(simpleTable)),
    assertion('index_addresses.address drifted to utf8mb4', 'assertStakeWeightOrderingCollation',
        /index_addresses\.address is utf8mb4 \/ utf8mb4_general_ci but src\/sql declares utf8 \/ utf8_general_ci/,
        'CREATE TABLE index_addresses (address VARCHAR(120) NOT NULL PRIMARY KEY) ENGINE=InnoDB ' +
            'DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci'),
    assertion('index_pubkeys.pubkey drifted to a binary collation', 'assertStakeWeightOrderingCollation', /index_pubkeys\.pubkey is utf8 \/ utf8_bin/,
        'CREATE TABLE index_pubkeys (pubkey CHAR(64) NOT NULL PRIMARY KEY) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_bin'),
    assertion('both ordering columns on the declared utf8 collation', 'assertStakeWeightOrderingCollation', undefined,
        'CREATE TABLE index_addresses (address VARCHAR(120) NOT NULL PRIMARY KEY)' + UTF8,
        'CREATE TABLE index_pubkeys (pubkey CHAR(64) NOT NULL PRIMARY KEY)' + UTF8),
    assertion('ordering tables absent', 'assertStakeWeightOrderingCollation'),
];
const SETTLED = BRIDGE_TABLES.concat(LIST_TABLES).map(simpleTable);
const NARROW_TICK = 'CREATE TABLE oracle_prices (id INT NOT NULL PRIMARY KEY, tick VARCHAR(100) NOT NULL)';
const AUTO_COLUMN = 'CREATE TABLE guard_probe (value BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY)';
const TIMESTAMP_COLUMN =
    'CREATE TABLE guard_probe (value TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)';
const GENERATED_COLUMN = 'CREATE TABLE guard_probe (base INT NOT NULL, value INT AS (base + 1) VIRTUAL)';
const liveColumn = (name, ddl, modify, refuses) => ({ name, ddl, modify, refuses });
const LIVE_COLUMN_CASES = [
    liveColumn('AUTO_INCREMENT', AUTO_COLUMN, 'BIGINT UNSIGNED NOT NULL', /strips AUTO_INCREMENT/),
    liveColumn('DEFAULT', 'CREATE TABLE guard_probe (value INT NOT NULL DEFAULT 7)',
        'INT NOT NULL /* DEFAULT 7 */', /strips DEFAULT 7/),
    liveColumn('ON UPDATE', TIMESTAMP_COLUMN, 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP', /strips ON UPDATE/),
    liveColumn('COMMENT', "CREATE TABLE guard_probe (value BIGINT UNSIGNED COMMENT 'kept')",
        'BIGINT UNSIGNED', /strips COMMENT/),
    liveColumn('generation expression', GENERATED_COLUMN, 'INT', /strips the generation expression/),
    liveColumn('integer width', 'CREATE TABLE guard_probe (value BIGINT NOT NULL)',
        'INT NOT NULL', /narrows the type \(bigint -> int\)/),
    liveColumn('integer signedness', 'CREATE TABLE guard_probe (value BIGINT NOT NULL)',
        'BIGINT UNSIGNED NOT NULL', /narrows the type \(bigint -> bigint unsigned\)/),
    liveColumn('character width', 'CREATE TABLE guard_probe (value VARCHAR(250) CHARACTER SET utf8mb4 NOT NULL)',
        'VARCHAR(100) CHARACTER SET utf8mb4 NOT NULL', /narrows the type \(varchar\(250\) -> varchar\(100\)\)/),
    liveColumn('decimal precision', 'CREATE TABLE guard_probe (value DECIMAL(10,4) NOT NULL)',
        'DECIMAL(8,3) NOT NULL', /narrows the type \(decimal\(10,4\) -> decimal\(8,3\)\)/),
    liveColumn('enum members', "CREATE TABLE guard_probe (value ENUM('a','b') NOT NULL)",
        "ENUM('a') NOT NULL", /narrows the type \(enum drops b\)/),
    liveColumn('character set', 'CREATE TABLE guard_probe (value VARCHAR(100) CHARACTER SET utf8mb4 NOT NULL)',
        'VARCHAR(100) CHARACTER SET utf8 NOT NULL', /changes the charset \(utf8mb4 -> utf8\)/),
    liveColumn('restated AUTO_INCREMENT', AUTO_COLUMN, 'BIGINT UNSIGNED NOT NULL AUTO_INCREMENT'),
    liveColumn('restated DEFAULT and COMMENT',
        "CREATE TABLE guard_probe (value INT NOT NULL DEFAULT 7 COMMENT 'kept')", "INT NOT NULL DEFAULT 7 COMMENT 'kept'"),
    liveColumn('restated ON UPDATE', TIMESTAMP_COLUMN,
        'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'),
    liveColumn('restated generation expression', GENERATED_COLUMN, 'INT AS (base + 1) VIRTUAL'),
    liveColumn('wider integer', 'CREATE TABLE guard_probe (value INT NOT NULL)', 'BIGINT NOT NULL'),
    liveColumn('wider character column and character set',
        'CREATE TABLE guard_probe (value VARCHAR(100) CHARACTER SET utf8 NOT NULL)',
        'VARCHAR(250) CHARACTER SET utf8mb4 NOT NULL'),
    liveColumn('expanded enum', "CREATE TABLE guard_probe (value ENUM('a') NOT NULL)", "ENUM('a','b') NOT NULL"),
];
function guardSql(definition) {
    return '/* live metadata probe */ ALTER TABLE guard_probe MODIFY COLUMN value ' + definition;
}
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
        h.admin = await mariadb.createConnection({ host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASS });
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
            if (!c.baseline) return assert.strictEqual(
                reason, null, 'a shape that still needs the migration must not be baselined');
            assert.strictEqual(typeof reason, 'string', 'a converged shape must be reported as not applicable');
            assert.ok(reason.length > 0);
        });
    }
}

function defineAssertions(h) {
    for (const c of ASSERTIONS) {
        it((c.refuses ? 'refuses: ' : 'allows: ') + c.name + ' (' + c.method + ')', async function () {
            await h.reset();
            await h.build(c.ddl);
            const run = () => Database.prototype[c.method].call(h.db);
            if (!c.refuses) return run();
            await assert.rejects(run, (err) => { assert.match(err.message, c.refuses); return true; });
        });
    }
}

function defineLiveColumnLosses(h) {
    it('covers every refusal category emitted by the live-column guard', function () {
        const refused = LIVE_COLUMN_CASES.filter(c => c.refuses).map(c => c.refuses.source).join(' ');
        for (const category of [
            'strips AUTO_INCREMENT', 'strips DEFAULT', 'strips ON UPDATE', 'strips COMMENT',
            'strips the generation expression', 'narrows the type', 'changes the charset',
        ]) assert.ok(refused.includes(category), category + ' needs a real-server case');
        assert.ok(LIVE_COLUMN_CASES.some(c => !c.refuses), 'the guard needs allowed real-server shapes');
    });
    for (const c of LIVE_COLUMN_CASES) {
        it((c.refuses ? 'refuses: ' : 'allows: ') + c.name + ' from server metadata', async function () {
            await h.reset();
            await h.build([c.ddl]);
            const run = () => h.withConn(conn => assertNoLiveColumnLoss(
                conn, 'server-metadata.sql', [guardSql(c.modify)]));
            if (!c.refuses) return run();
            await assert.rejects(run, (err) => {
                assert.match(err.message, c.refuses);
                assert.match(err.message, /guard_probe\.value/);
                return true;
            });
        });
    }
    it('allows a MODIFY when the live table or column is absent', async function () {
        await h.reset();
        await h.withConn(conn => assertNoLiveColumnLoss(
            conn, 'absent.sql', [guardSql('INT NOT NULL')]));
        await h.build(['CREATE TABLE guard_probe (other INT NOT NULL)']);
        await h.withConn(conn => assertNoLiveColumnLoss(
            conn, 'absent.sql', [guardSql('INT NOT NULL')]));
    });
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
        assert.ok(!result.pending.includes(TICK), 'the baselined migration must not remain pending');
        assert.deepStrictEqual((await h.ledger()).map(r => r.name), [TICK]);
        const rows = await h.withConn(conn => conn.query('SELECT tick FROM oracle_prices'));
        assert.deepStrictEqual(rows.map(r => r.tick), ['kept']);
        const again = await h.db.runMigrations({ only: [TICK] });
        assert.ok(!again.baselined.includes(TICK), 'an applied migration must not be baselined twice');
        assert.ok(!again.applied.includes(TICK), 'an applied migration must not run later');
        assert.ok(!again.pending.includes(TICK), 'an applied migration must not return to pending');
    });
    it('keeps a not-converged manual migration pending on a passive start', async function () {
        await h.build(SETTLED.concat([NARROW_TICK]));
        const result = await h.db.runMigrations({ only: [TICK] });
        assert.ok(result.pending.includes(TICK), 'the not-converged migration must remain pending');
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
    it('refuses a lossy auto MODIFY before DDL or ledger insertion', async function () {
        await h.build(SETTLED.concat([
            'CREATE TABLE deposits (id INT NOT NULL PRIMARY KEY, contract_index BIGINT UNSIGNED DEFAULT 7)',
        ]));
        await assert.rejects(() => h.db.runMigrations({ only: [NULLABLE] }), /strips DEFAULT 7/);
        const rows = await h.withConn(conn => conn.query(
            "SELECT COLUMN_DEFAULT AS value FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? " +
            "AND TABLE_NAME = 'deposits' AND COLUMN_NAME = 'contract_index'", [DB_NAME]));
        assert.strictEqual(String(rows[0].value), '7', 'the refused MODIFY must leave the live default intact');
        assert.deepStrictEqual(await h.ledger(), [], 'the refused migration must not be recorded');
    });
    it('applies and records an auto MODIFY whose live columns carry no extra attributes', async function () {
        const columns = [['deposits', 'contract_index'], ['withdrawals', 'contract_index'],
            ['contract_executions', 'contract_index'], ['contract_stakes', 'target_contract_index'],
            ['contract_unstakes', 'target_contract_index']];
        await h.build(SETTLED.concat(columns.map(([table, column]) =>
            'CREATE TABLE `' + table + '` (id INT NOT NULL PRIMARY KEY, `' + column + '` BIGINT UNSIGNED)')));
        const result = await h.db.runMigrations({ only: [NULLABLE] });
        assert.deepStrictEqual(result.applied, [NULLABLE]);
        assert.deepStrictEqual(result.baselined, []);
        assert.deepStrictEqual((await h.ledger()).map(r => r.name), [NULLABLE]);
    });
}

describe('migration live-schema guard against a real MariaDB @tier3', function () {
    this.timeout(120000);
    const h = schemaHarness();
    defineCoverage();
    describe('precondition verdict per live shape', () => defineVerdicts(h));
    describe('startup assertions refuse a drifted live schema', () => defineAssertions(h));
    describe('MODIFY loss detection from live information_schema rows', () => defineLiveColumnLosses(h));
    describe('through the production runner', () => defineRunner(h));
});
