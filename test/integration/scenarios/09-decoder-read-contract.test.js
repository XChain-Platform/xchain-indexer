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
 * Integration test: decoder -> indexer DB READ CONTRACT.
 *
 * The indexer reads block data from the decoder's database via a single hand-written
 * JOIN query (db.js:getDecoderBlockData). The decoder produces that schema from its own
 * canonical DDL (xchain-decoder/src/sql/*.sql). These are two independent code paths in
 * two independent repos; nothing structurally guarantees the columns the indexer SELECTs
 * still exist in what the decoder produces.
 *
 * That seam has already bitten us: a test harness that was missing transactions.raw_data,
 * transactions.fee, and the pubkeys table made getDecoderBlockData error, so the indexer
 * silently produced ZERO actions (~18 integration tests went red with no obvious cause).
 * The harness now loads the decoder's real .sql, but a renamed/dropped decoder column or a
 * new column added to the indexer's SELECT would still re-open the same silent-zero hole.
 *
 * This test pins the contract against the decoder's REAL production DDL (loaded by
 * createDecoderSchema from xchain-decoder/src/sql) in two ways:
 *   A. Static: every column getDecoderBlockData() reads exists in the decoder schema.
 *   B. Behavioral: the actual query executes against that schema and returns the
 *      normalized shape, with pubkey / raw_data / fee round-tripping through the JOIN.
 *
 * Run with the disposable test DB (handoff runbook):
 *   TEST_DB_HOST=127.0.0.1 TEST_DB_PORT=13307 TEST_DB_USER=root TEST_DB_PASS=mvhtest \
 *   INDEXER_COIN=BTC INDEXER_NETWORK=regtest npx mocha test/integration/scenarios/09-decoder-read-contract.test.js
 */

'use strict';

const assert = require('assert');
const { decoderQuery, createDatabases, createDecoderSchema,
        resetDecoderDb, getConnectionParams, closeAll } = require('../setup/db-connection');
const DecoderSeeder = require('../setup/decoder-seeder');
const { destroyFileIndexers } = require('../setup/indexer-launcher');

// Build a standalone decoder-DB handle exactly the way XChainIndexer does
// (db.js Database needs only indexer.config + indexer.util).
const config   = require('../../../src/config.js');
const Utility  = require('../../../src/utility.js');
const Database = require('../../../src/db.js');

// THE CONTRACT: the decoder columns the indexer's getDecoderBlockData() reads.
// Keep this in lock-step with src/db.js:getDecoderBlockData. If you change the
// SELECT, change this map, and this test re-validates it against the real schema.
const READ_SURFACE = {
    transactions:        ['data', 'raw_data', 'amount', 'fee', 'block_index', 'tx_hash_id', 'tx_index', 'source_id', 'destination_id'],
    blocks:              ['block_index', 'block_time'],
    index_transactions:  ['id', 'hash'],
    transaction_outputs: ['tx_index', 'vout', 'amount', 'destination_id'],
    index_addresses:     ['id', 'address'],
    pubkeys:             ['address_id', 'pubkey'],
};

// Keys getDecoderBlockData() promises its callers (after its post-query normalization).
const NORMALIZED_KEYS = ['data', 'raw_data', 'tx_hash', 'source', 'destination',
                         'amount', 'fee', 'block_index', 'block_time', 'vout', 'source_pubkey'];

const SOURCE = 'mn2YrLgFdvZ9MUK64a7TBn3ZVDKFo13b86'; // valid regtest P2PKH (passes isCryptoAddress)
const DEST   = 'mvQLUzhdrR1gGQmHLkMy62Y86o6ahgRo8h';
const BASE_TIME = 1700000000;

describe('Decoder->indexer DB read contract @regression @tier1', function () {
    this.timeout(30000);

    let decoderDb, seeder, decoderDbName;

    before(async function () {
        process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
        process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';
        await createDatabases(__filename);
        await createDecoderSchema();   // loads xchain-decoder/src/sql/*.sql (the REAL DDL)

        const p = getConnectionParams();
        decoderDbName = p.decoderName;
        const fakeIndexer = { config: config.getConfig(), util: new Utility() };
        decoderDb = new Database(p.decoderHost, p.decoderPort, p.decoderName,
                                 p.decoderUser, p.decoderPass, fakeIndexer);
        seeder = new DecoderSeeder(decoderQuery);
    });

    after(async function () {
        if (decoderDb && decoderDb.pool) await decoderDb.pool.end();
        await destroyFileIndexers(__filename);
        await closeAll();
    });

    beforeEach(async function () {
        await resetDecoderDb();
        seeder.reset();
    });

    // -----------------------------------------------------------------------
    // A. Static contract: declared read surface ⊆ decoder's real columns.
    // -----------------------------------------------------------------------
    it('every column getDecoderBlockData() reads exists in the decoder production schema', async function () {
        for (const [table, cols] of Object.entries(READ_SURFACE)) {
            const rows = await decoderQuery(
                'SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema = ? AND table_name = ?',
                [decoderDbName, table]
            );
            assert.ok(rows.length > 0,
                `decoder table "${table}" does not exist in the production schema, but the indexer reads from it`);
            const have = new Set(rows.map(r => r.COLUMN_NAME));
            const missing = cols.filter(c => !have.has(c));
            assert.deepStrictEqual(missing, [],
                `decoder table "${table}" is missing column(s) the indexer reads: ${missing.join(', ')}`);
        }
    });

    // -----------------------------------------------------------------------
    // B. Behavioral contract: the real query runs against the real schema and
    //    returns the normalized shape. This is the guard that fails LOUD on the
    //    exact bug class (missing column -> query throws -> 0 actions silently).
    // -----------------------------------------------------------------------
    it('getDecoderBlockData() executes against the real schema and returns the normalized shape', async function () {
        const BLOCK = 100;
        await seeder.seedBlock(BLOCK, BASE_TIME, [
            { source: SOURCE, destination: DEST, amount: '500', data: 'SEND|0|TEST|100|' + DEST }
        ]);

        // Round-trip the columns the seeder leaves null: raw_data (MEDIUMBLOB) + fee,
        // and a pubkeys row so the LEFT JOIN on pubkeys is actually exercised.
        const rawBytes = Buffer.from('deadbeef', 'hex');
        await decoderQuery('UPDATE transactions SET raw_data = ?, fee = ? WHERE tx_index = 1', [rawBytes, 1234]);
        const srcId = seeder.addressCache[SOURCE];
        assert.ok(srcId, 'seeder should have created the source address id');
        await decoderQuery('INSERT INTO pubkeys (address_id, pubkey) VALUES (?, ?)', [srcId, '02' + 'ab'.repeat(32)]);

        const rows = await decoderDb.getDecoderBlockData(BLOCK);

        assert.ok(rows.length >= 1, 'expected at least one decoded row for the seeded block');
        const row = rows[0];

        // Every promised key must be present (a renamed/dropped column surfaces here).
        for (const key of NORMALIZED_KEYS) {
            assert.ok(key in row, `getDecoderBlockData() result is missing promised key: "${key}"`);
        }

        // The JOINed/round-tripped values actually came through.
        assert.strictEqual(row.source, SOURCE, 'source address should resolve via index_addresses JOIN');
        assert.strictEqual(Number(row.block_index), BLOCK);
        assert.strictEqual(Number(row.block_time), BASE_TIME, 'block_time should resolve via blocks JOIN');
        assert.strictEqual(Number(row.fee), 1234, 'fee column should round-trip');
        assert.ok(row.raw_data != null, 'raw_data column should round-trip (was a missing-column bug source)');
        assert.ok(Buffer.isBuffer(row.raw_data) || typeof row.raw_data === 'string', 'raw_data should be blob-like');
        assert.ok(row.source_pubkey && String(row.source_pubkey).startsWith('02'),
            'source_pubkey should resolve via the pubkeys LEFT JOIN');
    });

    it('returns an empty array (not an error) for a block with no transactions', async function () {
        // The query must still be schema-valid even when nothing matches; this proves the
        // JOINs/columns resolve independent of whether rows exist.
        const rows = await decoderDb.getDecoderBlockData(999999);
        assert.deepStrictEqual(rows, []);
    });
});
