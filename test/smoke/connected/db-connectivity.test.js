/**
 * Smoke tests: Database connectivity (SM-05 through SM-09)
 *
 * Requires a running MariaDB instance with the decoder and indexer databases
 * already created. Reads credentials from .env at the project root.
 *
 * SM-05: Decoder DB pool connects
 * SM-06: Indexer DB pool connects
 * SM-07: Indexer DB schema exists
 * SM-08: Indexer DB tables exist
 * SM-09: Decoder DB is readable
 */

'use strict';

// Load .env BEFORE setting test env vars
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '..', '.env') });

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert  = require('assert');
const mariadb = require('mariadb');

// Pull credentials from env (populated by dotenv above)
const DECODER_HOST = process.env.DECODER_DB_HOST || '127.0.0.1';
const DECODER_PORT = parseInt(process.env.DECODER_DB_PORT || '3306');
const DECODER_NAME = process.env.DECODER_DB_NAME || 'XChain_Decoder';
const DECODER_USER = process.env.DECODER_DB_USER || 'root';
const DECODER_PASS = process.env.DECODER_DB_PASS || '';

const INDEXER_HOST = process.env.INDEXER_DB_HOST || '127.0.0.1';
const INDEXER_PORT = parseInt(process.env.INDEXER_DB_PORT || '3306');
const INDEXER_NAME = process.env.INDEXER_DB_NAME || 'XChain_Indexer';
const INDEXER_USER = process.env.INDEXER_DB_USER || 'root';
const INDEXER_PASS = process.env.INDEXER_DB_PASS || '';

// Pool options that prevent hangs when the DB is unreachable
const POOL_OPTS = {
    connectionLimit: 3,
    connectTimeout:  3000,   // fail fast if host is unreachable
    insertIdAsNumber: true,
};

let decoderPool = null;
let indexerPool = null;

describe('Smoke: database connectivity @regression @tier3', function () {
    this.timeout(5000);

    before(function () {
        decoderPool = mariadb.createPool({
            host: DECODER_HOST, port: DECODER_PORT,
            database: DECODER_NAME,
            user: DECODER_USER, password: DECODER_PASS,
            ...POOL_OPTS,
        });

        indexerPool = mariadb.createPool({
            host: INDEXER_HOST, port: INDEXER_PORT,
            database: INDEXER_NAME,
            user: INDEXER_USER, password: INDEXER_PASS,
            ...POOL_OPTS,
        });
    });

    after(async function () {
        if (decoderPool) { await decoderPool.end(); decoderPool = null; }
        if (indexerPool) { await indexerPool.end(); indexerPool = null; }
    });

    // -------------------------------------------------------------------------
    // SM-05: Decoder DB pool connects
    // -------------------------------------------------------------------------
    it('SM-05: decoder DB pool connects and releases a connection', async function () {
        const conn = await decoderPool.getConnection();
        conn.release();
        // If we reach here without throwing, connectivity is confirmed
    });

    // -------------------------------------------------------------------------
    // SM-06: Indexer DB pool connects
    // -------------------------------------------------------------------------
    it('SM-06: indexer DB pool connects and releases a connection', async function () {
        const conn = await indexerPool.getConnection();
        conn.release();
    });

    // -------------------------------------------------------------------------
    // SM-07: Indexer DB schema exists
    // -------------------------------------------------------------------------
    it('SM-07: indexer DB schema exists in information_schema', async function () {
        const conn = await indexerPool.getConnection();
        let rows;
        try {
            rows = await conn.query(
                'SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
                [INDEXER_NAME]
            );
        } finally {
            conn.release();
        }
        assert.ok(rows.length > 0,
            `Expected schema "${INDEXER_NAME}" to exist in information_schema.SCHEMATA`);
    });

    // -------------------------------------------------------------------------
    // SM-08: Indexer DB tables exist
    // -------------------------------------------------------------------------
    it('SM-08: indexer DB has required tables', async function () {
        const conn = await indexerPool.getConnection();
        let rows;
        try {
            rows = await conn.query(
                'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?',
                [INDEXER_NAME]
            );
        } finally {
            conn.release();
        }

        assert.ok(rows.length > 0,
            `Expected at least one table in indexer DB "${INDEXER_NAME}" but found none`);

        const tableNames = rows.map(r => r.TABLE_NAME.toLowerCase());
        const required   = ['actions', 'tokens', 'balances', 'blocks'];
        for (const t of required) {
            assert.ok(tableNames.includes(t),
                `Expected table "${t}" to exist in indexer DB; found: ${tableNames.join(', ')}`);
        }
    });

    // -------------------------------------------------------------------------
    // SM-09: Decoder DB is readable
    // -------------------------------------------------------------------------
    it('SM-09: decoder DB is readable (MAX block_index query succeeds)', async function () {
        const conn = await decoderPool.getConnection();
        let rows;
        try {
            rows = await conn.query('SELECT MAX(block_index) AS max_block FROM blocks');
        } finally {
            conn.release();
        }

        // Result is always one row; value is null when the table is empty — both are fine
        assert.strictEqual(rows.length, 1, 'Expected exactly one result row');
        const maxBlock = rows[0].max_block;
        assert.ok(maxBlock === null || typeof maxBlock === 'number' || typeof maxBlock === 'bigint',
            `max_block should be null or a number, got: ${typeof maxBlock} (${maxBlock})`);
    });
});
