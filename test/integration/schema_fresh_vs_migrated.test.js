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
 * test/integration/schema_fresh_vs_migrated.test.js
 *
 * Builds the current schema through its two supported paths in a real
 * MariaDB: current table definitions for a fresh install, and the frozen
 * pre-ledger table shapes followed by every dated migration. The resulting
 * table, column, and index metadata must be identical.
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

const SQL_DIR = path.join(__dirname, '../../src/sql');
const MIGRATIONS_DIR = path.join(SQL_DIR, 'migrations');
const COLUMN_BASELINE = require('../fixtures/schema-baseline-origin.json').baseline;
const INDEX_BASELINE = require('../fixtures/schema-index-baseline-origin.json').baseline;

const DB_HOST = process.env.TEST_DB_HOST || '127.0.0.1';
const DB_PORT = parseInt(process.env.TEST_DB_PORT || '3306');
const DB_USER = process.env.TEST_DB_USER || 'root';
const DB_PASS = process.env.TEST_DB_PASS || '';
const DB_BASE = process.env.TEST_INDEXER_DB || 'xchain_test_indexer';

function scopedDbName(label) {
    const suffix = '_schema_' + label + '_' + crypto.createHash('sha1')
        .update(__filename).digest('hex').slice(0, 6);
    if (DB_BASE.length + suffix.length <= 64) return DB_BASE + suffix;
    const baseDigest = crypto.createHash('sha1').update(DB_BASE).digest('hex').slice(0, 6);
    return DB_BASE.slice(0, 64 - suffix.length - 7) + '_' + baseDigest + suffix;
}

const FRESH_DB = scopedDbName('fresh');
const MIGRATED_DB = scopedDbName('migrated');
const CURRENT_COLUMN_SPECS = new Map();

function testIndexer() {
    return {
        config: {},
        util: {
            sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
            throwError: (message) => { throw new Error(message); },
        },
    };
}

function currentTableTail(table) {
    const raw = fs.readFileSync(path.join(SQL_DIR, table + '.sql'), 'utf8');
    const match = /\)\s*(ENGINE\s*=\s*[^;]+)/i.exec(raw);
    assert.ok(match, table + '.sql must declare an ENGINE tail');
    return match[1].trim();
}

function agedColumnSpec(table, column) {
    if (!CURRENT_COLUMN_SPECS.has(table)) {
        const raw = fs.readFileSync(path.join(SQL_DIR, table + '.sql'), 'utf8');
        const currentColumns = Database.prototype.parseExpectedColumns.call(
            { stripSqlLineComments: Database.prototype.stripSqlLineComments }, raw);
        CURRENT_COLUMN_SPECS.set(table, new Map(currentColumns.map(entry => {
            const spec = entry.definition.replace(
                new RegExp('^\\s*`?' + entry.name + '`?\\s*', 'i'), '');
            return [entry.name.toLowerCase(), spec];
        })));
    }
    const currentSpec = CURRENT_COLUMN_SPECS.get(table).get(column.name.toLowerCase());
    assert.ok(currentSpec, table + '.' + column.name + ' must still exist in the current definition');
    const currentLiterals = new Map(
        (currentSpec.match(/'(?:''|\\\\.|[^'])*'/g) || []).map(literal => [literal.toUpperCase(), literal]));
    return column.spec.replace(/'(?:''|\\\\.|[^'])*'/g,
        literal => currentLiterals.get(literal.toUpperCase()) || literal);
}

function quotedIndexColumn(spec) {
    const match = /^(\w+)(\(\d+\)?)?(\s+(?:ASC|DESC))?$/i.exec(String(spec).trim());
    assert.ok(match, 'unsupported frozen index column: ' + spec);
    const prefix = match[2] && !match[2].endsWith(')') ? match[2] + ')' : (match[2] || '');
    return '`' + match[1] + '`' + prefix + (match[3] || '');
}

function agedCreateSql(table) {
    const columns = COLUMN_BASELINE[table];
    assert.ok(columns && columns.length, 'aged baseline has no columns for ' + table);

    const clauses = columns.map(column => '`' + column.name + '` ' + agedColumnSpec(table, column));
    for (const index of INDEX_BASELINE[table] || []) {
        const columnList = index.columns.map(quotedIndexColumn).join(', ');
        if (String(index.name).toLowerCase() === 'primary') {
            clauses.push('PRIMARY KEY (' + columnList + ')');
        } else {
            clauses.push((index.unique ? 'UNIQUE ' : '') + 'KEY `' + index.name + '` (' + columnList + ')');
        }
    }
    return 'CREATE TABLE `' + table + '` (\n  ' + clauses.join(',\n  ') + '\n) ' + currentTableTail(table);
}

async function createAgedSchema(conn) {
    for (const table of Object.keys(COLUMN_BASELINE).sort()) {
        await conn.query(agedCreateSql(table));
    }
}

const COLUMN_FIELDS = [
    'TABLE_NAME', 'COLUMN_NAME', 'ORDINAL_POSITION', 'COLUMN_DEFAULT', 'IS_NULLABLE',
    'DATA_TYPE', 'COLUMN_TYPE', 'CHARACTER_SET_NAME', 'COLLATION_NAME', 'EXTRA',
    'COLUMN_COMMENT', 'GENERATION_EXPRESSION',
];
const INDEX_FIELDS = [
    'TABLE_NAME', 'INDEX_NAME', 'NON_UNIQUE', 'INDEX_TYPE', 'SEQ_IN_INDEX',
    'COLUMN_NAME', 'SUB_PART', 'COLLATION', 'NULLABLE', 'INDEX_COMMENT',
];
const TABLE_FIELDS = ['TABLE_NAME', 'ENGINE', 'ROW_FORMAT', 'TABLE_COLLATION', 'CREATE_OPTIONS'];

function plainRows(rows, fields) {
    return rows.map(row => Object.fromEntries(fields.map(field => [field, row[field]])));
}

async function schemaSnapshot(conn, database) {
    const tables = await conn.query(
        'SELECT ' + TABLE_FIELDS.join(', ') + ' FROM information_schema.TABLES ' +
        "WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME",
        [database]);
    const columns = await conn.query(
        'SELECT ' + COLUMN_FIELDS.join(', ') + ' FROM information_schema.COLUMNS ' +
        'WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION',
        [database]);
    const indexes = await conn.query(
        'SELECT ' + INDEX_FIELDS.join(', ') + ' FROM information_schema.STATISTICS ' +
        'WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX',
        [database]);
    return {
        tables: plainRows(tables, TABLE_FIELDS),
        columns: plainRows(columns, COLUMN_FIELDS),
        indexes: plainRows(indexes, INDEX_FIELDS),
    };
}

async function ledgerNames(conn) {
    const rows = await conn.query('SELECT name FROM schema_migrations ORDER BY name');
    return rows.map(row => row.name);
}

describe('fresh and migrated schema convergence against a real MariaDB @tier3', function () {
    this.timeout(120000);

    const ctx = {};

    before(async function () {
        if (process.env.TEST_DB_PASS === undefined) this.skip();
        assert.ok(DB_PASS, 'TEST_DB_PASS must be non-empty when the DB-backed suite is enabled');

        ctx.admin = await mariadb.createConnection({
            host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASS,
        });
        await ctx.admin.query('DROP DATABASE IF EXISTS `' + FRESH_DB + '`');
        await ctx.admin.query('DROP DATABASE IF EXISTS `' + MIGRATED_DB + '`');
        await ctx.admin.query('CREATE DATABASE `' + FRESH_DB + '`');
        await ctx.admin.query('CREATE DATABASE `' + MIGRATED_DB + '`');

        ctx.freshDb = new Database(DB_HOST, DB_PORT, FRESH_DB, DB_USER, DB_PASS, testIndexer());
        ctx.migratedDb = new Database(DB_HOST, DB_PORT, MIGRATED_DB, DB_USER, DB_PASS, testIndexer());
        ctx.freshConn = await mariadb.createConnection({
            host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASS, database: FRESH_DB,
        });
        ctx.migratedConn = await mariadb.createConnection({
            host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASS, database: MIGRATED_DB,
        });

        assert.strictEqual(await ctx.freshDb.verifyTables(), true);
        await createAgedSchema(ctx.migratedConn);
        ctx.freshSnapshot = await schemaSnapshot(ctx.freshConn, FRESH_DB);
        ctx.agedSnapshot = await schemaSnapshot(ctx.migratedConn, MIGRATED_DB);
    });

    after(async function () {
        if (ctx.freshDb && ctx.freshDb.pool) await ctx.freshDb.pool.end();
        if (ctx.migratedDb && ctx.migratedDb.pool) await ctx.migratedDb.pool.end();
        if (ctx.freshConn) await ctx.freshConn.end();
        if (ctx.migratedConn) await ctx.migratedConn.end();
        if (ctx.admin) {
            await ctx.admin.query('DROP DATABASE IF EXISTS `' + FRESH_DB + '`');
            await ctx.admin.query('DROP DATABASE IF EXISTS `' + MIGRATED_DB + '`');
            await ctx.admin.end();
        }
    });

    it('starts from a materially older schema rather than a second fresh install', function () {
        assert.strictEqual(ctx.agedSnapshot.tables.length, Object.keys(COLUMN_BASELINE).length);
        assert.ok(ctx.agedSnapshot.tables.length < ctx.freshSnapshot.tables.length,
            'the aged fixture must omit tables introduced by dated migrations');
        assert.notDeepStrictEqual(ctx.agedSnapshot.columns, ctx.freshSnapshot.columns,
            'the frozen pre-ledger columns must differ from the fresh schema');
        assert.notDeepStrictEqual(ctx.agedSnapshot.indexes, ctx.freshSnapshot.indexes,
            'the frozen pre-ledger indexes must differ from the fresh schema');
    });

    it('converges after replaying every migration through the production runner', async function () {
        const result = await ctx.migratedDb.runMigrations({ includeManual: true });
        assert.strictEqual(result.lockSkipped, false, 'the migration replay must hold its advisory lock');
        assert.deepStrictEqual(result.pending, [], 'includeManual must leave no migration pending');

        const migrationFiles = fs.readdirSync(MIGRATIONS_DIR)
            .filter(file => file.endsWith('.sql')).sort();
        assert.deepStrictEqual(await ledgerNames(ctx.migratedConn), migrationFiles,
            'the migrated database must record every migration before comparison');

        const migratedSnapshot = await schemaSnapshot(ctx.migratedConn, MIGRATED_DB);
        assert.deepStrictEqual(migratedSnapshot, ctx.freshSnapshot,
            'the fully migrated schema must match a fresh install in every table, column, and index attribute');
    });
});
