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
 * test/integration/datetime_migrations_real.test.js
 *
 * Drives the 2026-09-27-datetime-*.sql migrations against a REAL MariaDB.
 *
 * Every one of these files pins `SET time_zone = '+00:00'` before its MODIFY so the
 * TIMESTAMP-to-DATETIME retype preserves the already-stored UTC instant as a literal.
 * That claim is about what the SERVER does to a value across a session time zone
 * change, which a doQuery stub cannot answer. So this file builds each affected table
 * in its pre-migration TIMESTAMP shape, seeds one literal instant per column, applies
 * the real migration file, and reads the value back under a DIFFERENT session time
 * zone: a TIMESTAMP column shifts with the session, a DATETIME column must not.
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
const config   = require('../../src/config.js');
const Utility  = require('../../src/utility.js');

const dbc = require('./setup/db-connection');
const { DB_HOST, DB_PORT, DB_USER, DB_PASS } = dbc;   // empty DB_PASS => self-skip
const DB_NAME = process.env.TEST_DATETIME_MIGRATIONS_DB
    || dbc.scopedDbName(dbc.INDEXER_DB, dbc.fileKey(__filename));
const FRESH_DB_NAME = process.env.TEST_DATETIME_MIGRATIONS_FRESH_DB
    || dbc.scopedDbName(dbc.INDEXER_DB, dbc.fileKey(__filename) + ':fresh');

const SQL_DIR         = path.join(__dirname, '../../src/sql');
const MIGRATIONS_DIR  = path.join(SQL_DIR, 'migrations');

// The product's own stripper: the licence banner opens `--***` with no whitespace,
// which MySQL does not read as a comment, so a verbatim send is errno 1064.
const stripSqlLineComments = Database.prototype.stripSqlLineComments;
const splitSqlStatements   = (sql) => Database.prototype.splitSqlStatements.call(Database.prototype, sql);

const MIGRATION_FILES = fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^2026-09-27-datetime-.*\.sql$/.test(f))
    .sort();

// One entry per `ALTER TABLE <t> MODIFY <col> <def>` statement across the dated
// files, parsed off disk rather than hand-listed so a file added or dropped from
// the 2026-09-27-datetime- set changes what this suite covers without an edit here.
function parseRetypedColumns() {
    const out = [];
    for (const file of MIGRATION_FILES) {
        const raw = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
        for (const stmt of splitSqlStatements(raw)) {
            const m = /^ALTER\s+TABLE\s+(\S+)\s+MODIFY\s+(\S+)\s+([\s\S]+)$/i.exec(stmt.trim());
            if (m) out.push({ file, table: m[1], column: m[2], def: m[3].trim() });
        }
    }
    return out;
}

const RETYPED = parseRetypedColumns();
const TABLES  = Array.from(new Set(RETYPED.map((r) => r.table))).sort();

function retypedForFile(file) {
    return RETYPED.filter((r) => r.file === file);
}

const AGED_LITERAL          = '2026-01-15 12:34:56';
const AGED_READBACK_MINUS6  = '2026-01-15 06:34:56';   // TIMESTAMP shifts -6h under a -06:00 session
const LEDGER_FIXTURE_FILE     = '2020-01-01-datetime-migrations-fixture.sql';
const LEDGER_FIXTURE_CHECKSUM = '0'.repeat(64);

// The other NOT-NULL-with-no-default columns each table needs, minimally valid per
// its own src/sql/<table>.sql definition. The retyped column itself is added by the
// caller, since exactly one exists per table across the parsed migration set.
const MINIMAL_ROWS = {
    anchor_reward_attestations: {
        chain: 'BTC', network: 'regtest', reward_type: 'anchor_BTC',
        round_reference: 1, snapshot_block: 1, publisher: 'p'.repeat(64),
        reward_amount: '1', publisher_attestations: '[]',
    },
    bridge_transfers: {
        transfer_id: 't'.repeat(64), snapshot_block: 1, network: 'regtest',
        src_chain: 'BTC', src_action_index: 1, src_address: 'src_address',
        dest_chain: 'LTC', dest_address: 'dest_address', tick: 'XCHAIN',
        decimals: 8, amount: '1', effective_time: 1, validator_signatures: '[]',
    },
    policy_snapshots: {
        snapshot_id: 'p'.repeat(64), snapshot_block: 1, origin_chain: 'BTC',
        tick: 'TICK', policy_seq: 1, origin_block: 1, policy_hash: 'h'.repeat(64),
        effective_time: 1, network: 'regtest', validator_signatures: '[]',
    },
    capability_snapshots: {
        snapshot_block: 1, capability: 'cross_chain', signing_pubkey: 'k'.repeat(64),
        amount: '1',
    },
    cross_chain_matches: {
        match_id: 'match1', snapshot_block: 1, network: 'regtest', a_chain: 'BTC',
        a_action_index: 1, a_amount: '1', a_payout_addr: 'addr_a',
        b_chain: 'LTC', b_action_index: 1, b_amount: '1', b_payout_addr: 'addr_b',
        effective_time: 1, validator_signatures: '[]',
    },
    oracle_prices: {
        source_address: 'addr1', source_chain: 'BTC', coin: 'BTC', tick: 'TICK',
        fiat: 'USD', value: '1', block_time: 1, effective_at: 1, action_index: 1,
    },
    price_snapshots: {
        round_number: 1, coin_pair: 'BTC_USD', validator_count: 1,
        consensus_proof: '[]', status: 'finalized',
    },
    cross_chain_calls: {
        call_id: 'call1', phase: 'dispatch', snapshot_block: 1, network: 'regtest',
        source_chain: 'BTC', source_action_index: 1, source_contract_index: 1,
        target_chain: 'LTC', target_contract_index: 1, method: 'method1',
        params_json: '[]', gas_limit: 1, effective_time: 1, validator_signatures: '[]',
    },
    state_checkpoints: {
        chain: 'BTC', network: 'regtest', block_index: 1, block_hash: 'h'.repeat(64),
        ledger_hash: 'l'.repeat(64), actions_hash: 'a'.repeat(64), contract_hash: 'c'.repeat(64),
        checkpoint_seq: 1, snapshot_block: 1, validator_signatures: '[]',
    },
    state_tree_roots: {
        chain: 'BTC', network: 'regtest', block_index: 1, balances_root: 'b'.repeat(64),
        stakes_root: 's'.repeat(64), state_root: 'r'.repeat(64), block_merkle_root: 'm'.repeat(64),
    },
};

function buildInsertSql(table, row) {
    const cols = Object.keys(row);
    return {
        sql: 'INSERT INTO ' + table + ' (' + cols.join(', ') + ') VALUES (' + cols.map(() => '?').join(', ') + ')',
        params: cols.map((c) => row[c]),
    };
}

async function createTable(conn, table) {
    const raw = fs.readFileSync(path.join(SQL_DIR, table + '.sql'), 'utf8');
    for (const stmt of splitSqlStatements(stripSqlLineComments(raw))) await conn.query(stmt);
}

async function agedRetype(conn, entry) {
    const agedDef = entry.def.replace('DATETIME', 'TIMESTAMP');
    await conn.query('ALTER TABLE ' + entry.table + ' MODIFY ' + entry.column + ' ' + agedDef);
}

async function insertAgedRow(conn, entry) {
    const row = Object.assign({}, MINIMAL_ROWS[entry.table], { [entry.column]: AGED_LITERAL });
    const { sql, params } = buildInsertSql(entry.table, row);
    await conn.query(sql, params);
}

// Neither table carries a retyped column, but runMigrations() fail-closes on every
// return when either is absent (assertBridgeTablesPresent), so the aged fixture
// needs them just to let a scoped --file run complete.
const BRIDGE_ASSERTION_TABLES = ['bridge_settlements', 'xbridges'];

// Aged pre-migration fixture: every table in its TIMESTAMP shape, one seeded row
// each, all inserted on a connection pinned to UTC (see AGED_LITERAL above).
async function buildAgedShape(conn) {
    for (const table of TABLES.concat(BRIDGE_ASSERTION_TABLES)) await createTable(conn, table);
    for (const entry of RETYPED) await agedRetype(conn, entry);
    for (const entry of RETYPED) await insertAgedRow(conn, entry);
}

// The ledger's own TIMESTAMP-shaped past: ensureMigrationsLedger creates the table
// fresh as DATETIME, so this ages it back down and backdates one fixture row, on the
// pool connection the way the real runner reaches schema_migrations.
async function buildAgedLedger(db) {
    const conn = await db.getConnection();
    try {
        await db.ensureMigrationsLedger(conn);
        await conn.query('ALTER TABLE schema_migrations MODIFY applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP');
        await conn.query(
            'INSERT INTO schema_migrations (name, checksum, mode, applied_at) VALUES (?, ?, ?, ?)',
            [LEDGER_FIXTURE_FILE, LEDGER_FIXTURE_CHECKSUM, 'manual', AGED_LITERAL]);
    } finally {
        await conn.release();
    }
}

async function columnMeta(conn, table, column) {
    const rows = await conn.query(
        'SELECT DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA FROM information_schema.COLUMNS ' +
        'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [table, column]);
    return rows[0];
}

// schema_migrations carries many rows once runMigrations starts recording real
// applies; every other table here carries exactly the one fixture row.
function whereForTable(table) {
    return (table === 'schema_migrations')
        ? { sql: 'WHERE name = ?', params: [LEDGER_FIXTURE_FILE] }
        : { sql: 'LIMIT 1', params: [] };
}

async function readBackValue(conn, table, column) {
    const where = whereForTable(table);
    const rows = await conn.query(
        'SELECT DATE_FORMAT(' + column + ', \'%Y-%m-%d %H:%i:%s\') AS v FROM ' + table + ' ' + where.sql,
        where.params);
    return rows[0].v;
}

async function assertMigratedColumn(conn, table, column) {
    const meta = await columnMeta(conn, table, column);
    assert.strictEqual(String(meta.DATA_TYPE).toLowerCase(), 'datetime',
        table + '.' + column + ' must read DATA_TYPE datetime after migration');
    const value = await readBackValue(conn, table, column);
    assert.strictEqual(value, AGED_LITERAL,
        table + '.' + column + ' must keep the UTC instant as a literal after migration');
}

async function snapshotColumn(conn, table, column) {
    const meta = await columnMeta(conn, table, column);
    return {
        COLUMN_TYPE: meta.COLUMN_TYPE, IS_NULLABLE: meta.IS_NULLABLE,
        COLUMN_DEFAULT: meta.COLUMN_DEFAULT, EXTRA: meta.EXTRA,
        value: await readBackValue(conn, table, column),
    };
}

// Every field below is populated by setUp() and read by the it()s through this
// same object reference, since it() bodies run long after registration.
async function setUp(ctx) {
    ctx.adminConn = await mariadb.createConnection({
        host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASS, multipleStatements: true });
    await ctx.adminConn.query('DROP DATABASE IF EXISTS ' + DB_NAME + '; CREATE DATABASE ' + DB_NAME + ';');
    await ctx.adminConn.query('DROP DATABASE IF EXISTS ' + FRESH_DB_NAME + '; CREATE DATABASE ' + FRESH_DB_NAME + ';');

    const cfg = config.getConfig();
    ctx.db = new Database(DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASS, { config: cfg, util: new Utility(cfg) });

    ctx.writeConn = await mariadb.createConnection({
        host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASS, database: DB_NAME });
    await ctx.writeConn.query("SET time_zone = '+00:00'");
    ctx.readConn = await mariadb.createConnection({
        host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASS, database: DB_NAME });
    await ctx.readConn.query("SET time_zone = '-06:00'");
    ctx.freshConn = await mariadb.createConnection({
        host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASS, database: FRESH_DB_NAME });

    await buildAgedShape(ctx.writeConn);
    await buildAgedLedger(ctx.db);
}

async function tearDown(ctx) {
    if (ctx.db && ctx.db.pool) await ctx.db.pool.end();
    if (ctx.writeConn) await ctx.writeConn.end();
    if (ctx.readConn) await ctx.readConn.end();
    if (ctx.freshConn) await ctx.freshConn.end();
    if (ctx.adminConn) {
        await ctx.adminConn.query('DROP DATABASE IF EXISTS ' + DB_NAME);
        await ctx.adminConn.query('DROP DATABASE IF EXISTS ' + FRESH_DB_NAME);
        await ctx.adminConn.end();
    }
}

function registerAgedShapeTest(ctx) {
    it('the aged fixture stores every retyped column as TIMESTAMP, shifted by the read session', async function () {
        for (const entry of RETYPED) {
            const meta = await columnMeta(ctx.readConn, entry.table, entry.column);
            assert.strictEqual(String(meta.DATA_TYPE).toLowerCase(), 'timestamp',
                entry.table + '.' + entry.column + ' must start as TIMESTAMP');
            const value = await readBackValue(ctx.readConn, entry.table, entry.column);
            assert.strictEqual(value, AGED_READBACK_MINUS6,
                entry.table + '.' + entry.column + ' must shift -6h under a -06:00 session before migration');
        }
    });
}

function registerApplyTest(ctx, file, targets) {
    it('applies ' + file + ' and retypes its column(s) to DATETIME', async function () {
        const res = await ctx.db.runMigrations({ includeManual: true, only: [file] });
        assert.ok(!res.lockSkipped, 'runMigrations must not skip the lock');
        assert.ok(res.applied.includes(file), file + ' must be in applied');
        for (const t of targets) await assertMigratedColumn(ctx.readConn, t.table, t.column);
        await assertMigratedColumn(ctx.readConn, 'schema_migrations', 'applied_at');
    });
}

function registerReapplyTest(ctx, file, targets) {
    it('re-running ' + file + ' is a no-op and leaves its column(s) unchanged', async function () {
        const snapshotBefore = {};
        for (const t of targets) snapshotBefore[t.column] = await snapshotColumn(ctx.readConn, t.table, t.column);

        const res = await ctx.db.runMigrations({ includeManual: true, only: [file] });
        assert.ok(!res.applied.includes(file), file + ' must not re-apply on a second run');

        for (const t of targets) {
            const snapshotAfter = await snapshotColumn(ctx.readConn, t.table, t.column);
            assert.deepStrictEqual(snapshotAfter, snapshotBefore[t.column],
                t.table + '.' + t.column + ' must be unchanged by a no-op re-run');
        }
    });
}

function registerApplyTests(ctx) {
    for (const file of MIGRATION_FILES) {
        const targets = retypedForFile(file);
        registerApplyTest(ctx, file, targets);
        registerReapplyTest(ctx, file, targets);
    }
}

function registerFreshComparisonTest(ctx) {
    it('a fresh install and the fully migrated aged database agree on every retyped column', async function () {
        for (const table of TABLES) await createTable(ctx.freshConn, table);
        for (const entry of RETYPED) {
            const fresh = await columnMeta(ctx.freshConn, entry.table, entry.column);
            const aged  = await columnMeta(ctx.readConn, entry.table, entry.column);
            const pick  = (m) => ({ COLUMN_TYPE: m.COLUMN_TYPE, IS_NULLABLE: m.IS_NULLABLE,
                COLUMN_DEFAULT: m.COLUMN_DEFAULT, EXTRA: m.EXTRA });
            assert.deepStrictEqual(pick(aged), pick(fresh),
                entry.table + '.' + entry.column + ' must match a fresh install after migration');
        }
    });
}

describe('DATETIME migration rehearsal against a real MariaDB @tier3', function () {
    this.timeout(120000);

    const ctx = {};

    before(async function () {
        if (!DB_PASS) this.skip();
        await setUp(ctx);
    });

    after(async function () { await tearDown(ctx); });

    registerAgedShapeTest(ctx);
    registerApplyTests(ctx);
    registerFreshComparisonTest(ctx);
});
