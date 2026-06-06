/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
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
 */

const mariadb = require('mariadb');
const path    = require('path');
const fs      = require('fs');

// Read .env manually for DB credentials only — avoid polluting INDEXER_COIN/NETWORK
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
const DB_PASS = process.env.TEST_DB_PASS || _envVars.INDEXER_DB_PASS || 'test';
const DECODER_DB = process.env.TEST_DECODER_DB || 'xchain_test_decoder';
const INDEXER_DB = process.env.TEST_INDEXER_DB || 'xchain_test_indexer';

let adminPool = null;
let decoderPool = null;
let indexerPool = null;

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

/** Create both test databases from scratch */
async function createDatabases() {
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
 * Create the decoder DB schema from xchain-decoder's canonical src/sql/*.sql — the SAME
 * declarative schema the decoder itself creates via db.verifyTables(). Loading the real
 * files (instead of a hand-maintained copy) means this harness can never silently drift
 * from the decoder schema again — the previous hand-rolled copy had fallen behind (missing
 * pubkeys, transactions.raw_data, transactions.fee), breaking the integration suite.
 *
 * Each canonical .sql begins with DROP TABLE IF EXISTS and seeds its sentinel rows, so this
 * is idempotent and doubles as the per-test reset. FK checks are disabled during the load
 * so file order is irrelevant (e.g. pubkeys -> index_addresses).
 */
async function createDecoderSchema() {
    if (!fs.existsSync(DECODER_SQL_DIR)) {
        throw new Error('Decoder schema dir not found: ' + DECODER_SQL_DIR +
            ' — set XCHAIN_DECODER_SQL_PATH to the xchain-decoder src/sql directory.');
    }
    const pool = getDecoderPool();
    const conn = await pool.getConnection();
    try {
        await conn.query('SET FOREIGN_KEY_CHECKS = 0');
        // Drop every existing table first so the load is clean regardless of whether each
        // canonical .sql opens with its own DROP TABLE IF EXISTS (some do, some are bare
        // CREATE or CREATE IF NOT EXISTS — re-running those would otherwise error).
        const existing = await conn.query('SHOW TABLES');
        for (const row of existing) {
            await conn.query('DROP TABLE IF EXISTS `' + Object.values(row)[0] + '`');
        }
        const files = fs.readdirSync(DECODER_SQL_DIR).filter(f => f.endsWith('.sql')).sort();
        for (const file of files) {
            // Strip `--` line comments (a ';' in comment prose must not split a statement),
            // then run each statement — mirrors xchain-decoder/src/db.js createTable().
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

/** Drop and recreate the indexer DB (clean slate — indexer creates its own tables) */
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

/** Close all connection pools */
async function closeAll() {
    if (decoderPool) { await decoderPool.end(); decoderPool = null; }
    if (indexerPool) { await indexerPool.end(); indexerPool = null; }
    if (adminPool)   { await adminPool.end(); adminPool = null; }
}

/** Return connection params for use with XChainIndexer constructor */
function getConnectionParams() {
    return {
        decoderHost: DB_HOST, decoderPort: DB_PORT, decoderName: DECODER_DB,
        decoderUser: DB_USER, decoderPass: DB_PASS,
        indexerHost: DB_HOST, indexerPort: DB_PORT, indexerName: INDEXER_DB,
        indexerUser: DB_USER, indexerPass: DB_PASS,
    };
}

module.exports = {
    decoderQuery, indexerQuery,
    createDatabases, createDecoderSchema,
    resetDecoderDb, resetIndexerDb,
    closeAll, getConnectionParams,
    DB_HOST, DB_PORT, DB_USER, DB_PASS, DECODER_DB, INDEXER_DB,
};
