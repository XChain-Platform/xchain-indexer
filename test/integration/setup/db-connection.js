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
 * Database connection manager for integration tests.
 *
 * Manages two MariaDB databases:
 *   - Decoder DB: seeded with simulated decoder output (read by the indexer)
 *   - Indexer DB: written by the indexer under test, queried by assertions
 *
 * Reads connection params from environment variables with sensible defaults
 * for local Docker testing.
 *
 * Each test FILE gets its own schemas, claimed by passing __filename to
 * createDatabases() / useFileDatabases(). See scopedDbName() for why one shared
 * name is not safe even in a serial tier.
 */

const mariadb = require('mariadb');
const crypto  = require('crypto');
const path    = require('path');
const fs      = require('fs');

// Read .env manually for DB credentials only, to avoid polluting INDEXER_COIN/NETWORK
const _envVars = {};
const _envPath = path.resolve(__dirname, '../../../.env');
if (fs.existsSync(_envPath)) {
    for (const line of fs.readFileSync(_envPath, 'utf8').split('\n')) {
        const m = line.match(/^\s*([\w]+)\s*=\s*(.*)$/);
        if (m) _envVars[m[1]] = m[2].trim();
    }
}

// TEST_DB_* env vars override; otherwise fall back to .env INDEXER_DB_* values
const DB_HOST = process.env.TEST_DB_HOST || _envVars.INDEXER_DB_HOST || '127.0.0.1';
const DB_PORT = parseInt(process.env.TEST_DB_PORT || _envVars.INDEXER_DB_PORT || '3306');
const DB_USER = process.env.TEST_DB_USER || _envVars.INDEXER_DB_USER || 'root';
const DB_PASS = process.env.TEST_DB_PASS || _envVars.INDEXER_DB_PASS || '';
// Base names. .ci-databases maps each of these as `name=ENV_VAR`, so under the
// gate they already arrive as ci_<name>_<run-id>; a hand run falls back to the
// literal. Every per-file schema is derived from a base, never invented, so
// whatever prefix the base carries is carried through.
const DECODER_DB_BASE = process.env.TEST_DECODER_DB || 'xchain_test_decoder';
const INDEXER_DB_BASE = process.env.TEST_INDEXER_DB || 'xchain_test_indexer';
// Second indexer DB for cross-node equivalence tests (two independent indexer
// instances over the SAME decoder DB (scenario 13).
const INDEXER_DB_B_BASE = process.env.TEST_INDEXER_DB_B || 'xchain_test_indexer_b';

// Active names. They stay at the base until a test file claims its own set, so
// non-mocha consumers of this module (the bin/verify-*-replay-equivalence tools
// drive the seeders directly, and pass the exact schema they intend to compare
// through TEST_INDEXER_DB) see the name they asked for, unchanged.
let DECODER_DB   = DECODER_DB_BASE;
let INDEXER_DB   = INDEXER_DB_BASE;
let INDEXER_DB_B = INDEXER_DB_B_BASE;
let activeKey    = null;

// Every scoped name handed out this process, dropped once the tier finishes.
const scopedDatabases = new Set();

const MAX_IDENTIFIER_LEN = 64;
const INTEGRATION_ROOT = path.resolve(__dirname, '..');

/**
 * Derive one file's schema name from a shared base.
 *
 * Sharing a single schema across files is unsafe even though the tier is
 * serial: mocha fails a hook that blows its timeout but does not cancel the
 * promise inside it, so an abandoned before/beforeEach keeps running its
 * verifyTables() DDL while the NEXT file's beforeEach has already dropped and
 * recreated that same schema underneath it. The surviving work then reports as
 * the next file's failure ("table doesn't exist" mid-index-create, then a
 * duplicate primary key on insert). Per-file names remove the shared object, so
 * an abandoned hook can only ever damage the file that abandoned it.
 *
 * The suffix keeps the base intact so the derived name inherits the base's ci_
 * prefix. That prefix is load-bearing: on at least one venue the CI database
 * user is granted only on ci_%, where a schema outside the prefix is created
 * happily and then refuses INSERT with error 1142.
 *
 * MariaDB stops at 64-character identifiers and the gate already clamps its own
 * name to 60, so a base near that clamp cannot simply carry a suffix. When it
 * would overflow, the base is cut and a digest of the WHOLE base folded in, so
 * two bases differing only past the cut still land on different schemas.
 */
function scopedDbName(base, key) {
    const tag = path.basename(key).replace(/\.test\.js$/, '')
        .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 16);
    const digest = crypto.createHash('sha1').update(key).digest('hex').slice(0, 6);
    const suffix = `_${tag}_${digest}`;
    if (base.length + suffix.length <= MAX_IDENTIFIER_LEN) return base + suffix;
    const baseDigest = crypto.createHash('sha1').update(base).digest('hex').slice(0, 6);
    return base.slice(0, MAX_IDENTIFIER_LEN - suffix.length - 7) + '_' + baseDigest + suffix;
}

/**
 * Identify a test file by its path relative to test/integration, so a scenario
 * and a top-level test that share a basename stay apart.
 */
function fileKey(testFile) {
    return path.relative(INTEGRATION_ROOT, testFile).split(path.sep).join('/');
}

/** The file whose schemas are currently active, or null before any claim. */
function activeFileKey() {
    return activeKey;
}

/**
 * Point this module's schemas at the calling test file's own set. Pass
 * __filename.
 *
 * Call it before the file touches any database. createDatabases() does it for
 * you; a file that only resets (it relies on the gate having created the
 * schema) calls this directly.
 */
async function useFileDatabases(testFile) {
    const key = fileKey(testFile);
    const nextDecoder = scopedDbName(DECODER_DB_BASE, key);
    const nextIndexer = scopedDbName(INDEXER_DB_BASE, key);
    const nextIndexerB = scopedDbName(INDEXER_DB_B_BASE, key);
    activeKey = key;
    if (nextDecoder === DECODER_DB && nextIndexer === INDEXER_DB) return;

    // Pools carry the database in their connection config, so they cannot be
    // reused across the switch.
    if (decoderPool)  { await decoderPool.end();  decoderPool = null; }
    if (indexerPool)  { await indexerPool.end();  indexerPool = null; }
    if (indexerBPool) { await indexerBPool.end(); indexerBPool = null; }

    DECODER_DB = nextDecoder;
    INDEXER_DB = nextIndexer;
    INDEXER_DB_B = nextIndexerB;
    scopedDatabases.add(nextDecoder).add(nextIndexer).add(nextIndexerB);
}

let adminPool = null;
let decoderPool = null;
let indexerPool = null;
let indexerBPool = null;

function getAdminPool() {
    if (!adminPool) {
        adminPool = mariadb.createPool({
            host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASS,
            connectionLimit: 5, insertIdAsNumber: true
        });
    }
    return adminPool;
}

function getDecoderPool() {
    if (!decoderPool) {
        decoderPool = mariadb.createPool({
            host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASS,
            database: DECODER_DB, connectionLimit: 5, insertIdAsNumber: true
        });
    }
    return decoderPool;
}

function getIndexerPool() {
    if (!indexerPool) {
        indexerPool = mariadb.createPool({
            host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASS,
            database: INDEXER_DB, connectionLimit: 5, insertIdAsNumber: true
        });
    }
    return indexerPool;
}

/** Run a query against the decoder DB */
async function decoderQuery(sql, args) {
    const pool = getDecoderPool();
    const conn = await pool.getConnection();
    try { return await conn.query(sql, args); }
    finally { conn.release(); }
}

/** Run a query against the indexer DB */
async function indexerQuery(sql, args) {
    const pool = getIndexerPool();
    const conn = await pool.getConnection();
    try { return await conn.query(sql, args); }
    finally { conn.release(); }
}

function getIndexerBPool() {
    if (!indexerBPool) {
        indexerBPool = mariadb.createPool({
            host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASS,
            database: INDEXER_DB_B, connectionLimit: 5, insertIdAsNumber: true
        });
    }
    return indexerBPool;
}

/** Run a query against the SECOND indexer DB (cross-node equivalence tests) */
async function indexerBQuery(sql, args) {
    const pool = getIndexerBPool();
    const conn = await pool.getConnection();
    try { return await conn.query(sql, args); }
    finally { conn.release(); }
}

/**
 * Create both test databases from scratch.
 *
 * @param {string} [testFile] - pass __filename to claim this file's own pair of
 *   schemas. Omitting it keeps whatever names are active, which is what the
 *   non-mocha tools that drive this module want.
 */
async function createDatabases(testFile) {
    if (testFile) await useFileDatabases(testFile);
    const pool = getAdminPool();
    const conn = await pool.getConnection();
    try {
        await conn.query(`DROP DATABASE IF EXISTS ${DECODER_DB}`);
        await conn.query(`CREATE DATABASE ${DECODER_DB}`);
        await conn.query(`DROP DATABASE IF EXISTS ${INDEXER_DB}`);
        await conn.query(`CREATE DATABASE ${INDEXER_DB}`);
    } finally {
        conn.release();
    }
}

// Canonical decoder schema lives in the xchain-decoder repo (sibling in the monorepo).
// Override with XCHAIN_DECODER_SQL_PATH if the layout differs.
const DECODER_SQL_DIR = process.env.XCHAIN_DECODER_SQL_PATH
    || path.resolve(__dirname, '../../../../xchain-decoder/src/sql');

/**
 * Create the decoder DB schema from xchain-decoder's canonical src/sql/*.sql (the SAME
 * declarative schema the decoder itself creates via db.verifyTables()). Loading the real
 * files (instead of a hand-maintained copy) means this harness can never silently drift
 * from the decoder schema. The previous hand-rolled copy had fallen behind (missing
 * pubkeys, transactions.raw_data, transactions.fee), breaking the integration suite.
 *
 * Each canonical .sql begins with DROP TABLE IF EXISTS and seeds its sentinel rows, so this
 * is idempotent and doubles as the per-test reset. FK checks are disabled during the load
 * so file order is irrelevant (e.g. pubkeys -> index_addresses).
 */
async function createDecoderSchema() {
    if (!fs.existsSync(DECODER_SQL_DIR)) {
        throw new Error('Decoder schema dir not found: ' + DECODER_SQL_DIR +
            '. Set XCHAIN_DECODER_SQL_PATH to the xchain-decoder src/sql directory.');
    }
    const pool = getDecoderPool();
    const conn = await pool.getConnection();
    try {
        await conn.query('SET FOREIGN_KEY_CHECKS = 0');
        // Drop every existing table first so the load is clean regardless of whether each
        // canonical .sql opens with its own DROP TABLE IF EXISTS (some do, some are bare
        // CREATE or CREATE IF NOT EXISTS; re-running those would otherwise error).
        const existing = await conn.query('SHOW TABLES');
        for (const row of existing) {
            await conn.query('DROP TABLE IF EXISTS `' + Object.values(row)[0] + '`');
        }
        const files = fs.readdirSync(DECODER_SQL_DIR).filter(f => f.endsWith('.sql')).sort();
        for (const file of files) {
            // Strip `--` line comments (a ';' in comment prose must not split a statement),
            // then run each statement. Mirrors xchain-decoder/src/db.js createTable().
            const sql = fs.readFileSync(path.join(DECODER_SQL_DIR, file), 'utf8')
                .replace(/--[^\n]*/g, '');
            for (let stmt of sql.split(';')) {
                stmt = stmt.trim();
                if (stmt) await conn.query(stmt);
            }
        }
        await conn.query('SET FOREIGN_KEY_CHECKS = 1');
    } finally {
        conn.release();
    }
}

/**
 * Reset the decoder DB between tests by reloading the canonical schema. Every decoder .sql
 * drops + recreates + reseeds its table, so this yields a pristine canonical state (and
 * restores the id=1 blank address/hash sentinels that a TRUNCATE would have wiped).
 */
async function resetDecoderDb() {
    await createDecoderSchema();
}

/** Drop and recreate the indexer DB (clean slate; indexer creates its own tables) */
async function resetIndexerDb() {
    const pool = getAdminPool();
    const conn = await pool.getConnection();
    try {
        await conn.query(`DROP DATABASE IF EXISTS ${INDEXER_DB}`);
        await conn.query(`CREATE DATABASE ${INDEXER_DB}`);
    } finally {
        conn.release();
    }
    // Reset the indexer pool so it reconnects to the fresh DB
    if (indexerPool) { await indexerPool.end(); indexerPool = null; }
}

/** Drop and recreate the SECOND indexer DB (cross-node equivalence tests) */
async function resetIndexerDbB() {
    const pool = getAdminPool();
    const conn = await pool.getConnection();
    try {
        await conn.query(`DROP DATABASE IF EXISTS ${INDEXER_DB_B}`);
        await conn.query(`CREATE DATABASE ${INDEXER_DB_B}`);
    } finally {
        conn.release();
    }
    if (indexerBPool) { await indexerBPool.end(); indexerBPool = null; }
}

/** Close all connection pools */
async function closeAll() {
    if (decoderPool)  { await decoderPool.end(); decoderPool = null; }
    if (indexerPool)  { await indexerPool.end(); indexerPool = null; }
    if (indexerBPool) { await indexerBPool.end(); indexerBPool = null; }
    if (adminPool)    { await adminPool.end(); adminPool = null; }
}

/**
 * Drop every schema this process handed out. Called once at the end of the
 * tier, not per file: a file's own schema has to outlive its last hook, since
 * an abandoned hook may still be writing to it.
 *
 * Best-effort. A leftover schema is venue litter, never a reason to fail a run.
 */
async function dropScopedDatabases() {
    if (scopedDatabases.size === 0) return;
    const pool = getAdminPool();
    let conn;
    try {
        conn = await pool.getConnection();
        for (const name of scopedDatabases) {
            try { await conn.query(`DROP DATABASE IF EXISTS \`${name}\``); } catch (e) { /* ignore */ }
        }
    } catch (e) {
        /* ignore */
    } finally {
        if (conn) conn.release();
        scopedDatabases.clear();
        try { await closeAll(); } catch (e) { /* ignore */ }
    }
}

// The per-file schemas are named per run (the gate's run id is in the base), so
// nothing would ever reclaim them. Registering here rather than in each test
// file makes that impossible to forget: mocha installs its BDD globals before
// loading a spec, and this module is first required from inside one, so this
// becomes a ROOT after hook that runs once the whole tier is done. Outside
// mocha (the bin/verify-* tools) `after` does not exist and nothing is scoped.
if (typeof after === 'function') {
    after(async function () {
        this.timeout(60000);
        await dropScopedDatabases();
    });
}

/** Name of the schema the ACTIVE test file writes as its second indexer node. */
function indexerDbNameB() {
    return INDEXER_DB_B;
}

/**
 * Return connection params for use with XChainIndexer constructor.
 * @param {string} [indexerName] - override the indexer DB name (defaults to
 *   the primary test indexer DB; pass indexerDbNameB() for a second node).
 */
function getConnectionParams(indexerName) {
    return {
        decoderHost: DB_HOST, decoderPort: DB_PORT, decoderName: DECODER_DB,
        decoderUser: DB_USER, decoderPass: DB_PASS,
        indexerHost: DB_HOST, indexerPort: DB_PORT, indexerName: indexerName || INDEXER_DB,
        indexerUser: DB_USER, indexerPass: DB_PASS,
    };
}

module.exports = {
    decoderQuery, indexerQuery, indexerBQuery,
    createDatabases, createDecoderSchema, useFileDatabases, scopedDbName,
    fileKey, activeFileKey,
    resetDecoderDb, resetIndexerDb, resetIndexerDbB,
    closeAll, dropScopedDatabases, getConnectionParams, indexerDbNameB,
    DB_HOST, DB_PORT, DB_USER, DB_PASS,
};

// Accessors, not values: the schema names change when a test file claims its
// own set, and a plain property would freeze whatever was active at require
// time. Destructuring one still snapshots, so a caller that needs the ACTIVE
// name reads it off the module (or calls indexerDbNameB()).
Object.defineProperties(module.exports, {
    DECODER_DB:   { enumerable: true, get: () => DECODER_DB },
    INDEXER_DB:   { enumerable: true, get: () => INDEXER_DB },
    INDEXER_DB_B: { enumerable: true, get: () => INDEXER_DB_B },
});
