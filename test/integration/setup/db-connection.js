/**
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

// Defaults match: docker run -e MARIADB_ROOT_PASSWORD=test -p 3307:3306 mariadb:10.11
const DB_HOST = process.env.TEST_DB_HOST || '127.0.0.1';
const DB_PORT = parseInt(process.env.TEST_DB_PORT || '3306');
const DB_USER = process.env.TEST_DB_USER || 'root';
const DB_PASS = process.env.TEST_DB_PASS || 'test';
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

/** Create the decoder DB schema (tables the indexer reads from) */
async function createDecoderSchema() {
    const pool = getDecoderPool();
    const conn = await pool.getConnection();
    try {
        await conn.query(`
            CREATE TABLE IF NOT EXISTS blocks (
                block_index INT UNSIGNED NOT NULL PRIMARY KEY,
                block_time  INT UNSIGNED DEFAULT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8
        `);
        await conn.query(`
            CREATE TABLE IF NOT EXISTS index_transactions (
                id   INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                hash VARCHAR(250) NOT NULL,
                UNIQUE KEY hash_idx (hash(64))
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8
        `);
        await conn.query(`
            CREATE TABLE IF NOT EXISTS index_addresses (
                id      INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                address VARCHAR(120) NOT NULL,
                UNIQUE KEY addr_idx (address(62))
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8
        `);
        await conn.query(`
            CREATE TABLE IF NOT EXISTS transactions (
                tx_index       INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                tx_hash_id     INT UNSIGNED DEFAULT NULL,
                block_index    INT UNSIGNED DEFAULT NULL,
                source_id      INT UNSIGNED DEFAULT NULL,
                destination_id INT UNSIGNED DEFAULT NULL,
                amount         VARCHAR(250) DEFAULT NULL,
                data           MEDIUMTEXT DEFAULT NULL,
                KEY block_index (block_index),
                KEY tx_hash_id (tx_hash_id),
                KEY source_id (source_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8
        `);
        await conn.query(`
            CREATE TABLE IF NOT EXISTS transaction_outputs (
                tx_index       INT UNSIGNED NOT NULL,
                vout           INT UNSIGNED NOT NULL DEFAULT 0,
                destination_id INT UNSIGNED DEFAULT NULL,
                amount         VARCHAR(250) DEFAULT NULL,
                PRIMARY KEY (tx_index, vout)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8
        `);
        await conn.query(`
            CREATE TABLE IF NOT EXISTS events (
                id   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                time DATETIME DEFAULT NULL,
                code VARCHAR(32) DEFAULT NULL,
                data TEXT DEFAULT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8
        `);
    } finally {
        conn.release();
    }
}

/** Truncate all decoder tables (fast reset between tests) */
async function resetDecoderDb() {
    const tables = ['events', 'transaction_outputs', 'transactions',
                    'index_addresses', 'index_transactions', 'blocks'];
    const pool = getDecoderPool();
    const conn = await pool.getConnection();
    try {
        await conn.query('SET FOREIGN_KEY_CHECKS = 0');
        for (const t of tables) await conn.query(`TRUNCATE TABLE ${t}`);
        await conn.query('SET FOREIGN_KEY_CHECKS = 1');
    } finally {
        conn.release();
    }
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
