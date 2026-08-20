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
 * Integration tests: Block Discovery and Sync
 *
 * Verifies that the indexer correctly discovers, syncs, and commits blocks
 * from the decoder DB in a variety of scenarios including empty blocks,
 * multi-block sequences, hash chaining, and action-index monotonicity.
 */

'use strict';

const assert = require('assert');
const { decoderQuery, indexerQuery, createDatabases, createDecoderSchema,
        resetDecoderDb, resetIndexerDb, closeAll } = require('../setup/db-connection');
const DecoderSeeder = require('../setup/decoder-seeder');
const { initIndexer, processBlocks, destroyIndexer, destroyFileIndexers } = require('../setup/indexer-launcher');
const { seedGas } = require('../setup/gas-seeder');
const { assertBlockCount, assertHashChain, countRows,
        getActionIndex } = require('../setup/assertion-helpers');

// Addresses: valid regtest P2PKH (base58check-validated)
const ADDR1 = 'msK1rsgNVFPM4cR3X5rngczTKa6EtT4WKD'; // 30 chars
const ADDR2 = 'mjifPngDYQ6HHPNQdGk1kQuFkJWEiQksQp'; // 30 chars
const ADDR3 = 'mwGujTXFXMLN2YXqo4mQK4DcKy31DUcwoi'; // 30 chars

// A block time baseline (unix epoch seconds, ~2023)
const BASE_TIME = 1700000000;

describe('Block Discovery and Sync @regression @tier3', function () {
    // Allow generous timeout for DB operations
    this.timeout(30000);

    let seeder, indexer;

    before(async function () {
        await createDatabases(__filename);
        await createDecoderSchema();
    });

    beforeEach(async function () {
        await resetDecoderDb();
        await resetIndexerDb();
        seeder = new DecoderSeeder(decoderQuery);
        indexer = await initIndexer();
    });

    afterEach(async function () {
        await destroyIndexer(indexer);
    });

    after(async function () {
        await destroyFileIndexers(__filename);
        await closeAll();
    });

    // -----------------------------------------------------------------------
    // 1. Initial sync from empty state: seed 3 blocks, verify all processed
    // -----------------------------------------------------------------------
    it('initial sync processes all seeded blocks', async function () {
        // Fee era: the ISSUE below needs gas
        await seedGas(seeder, { blockIndex: 99, addresses: [ADDR1, ADDR2, ADDR3] });
        await seeder.seedBlock(100, BASE_TIME, [
            { source: ADDR1, data: 'ISSUE|0|ALPHA|1000|100|0|First token' }
        ]);
        await seeder.seedBlock(101, BASE_TIME + 10, [
            { source: ADDR1, data: 'MINT|0|ALPHA|50' }
        ]);
        await seeder.seedBlock(102, BASE_TIME + 20, [
            { source: ADDR1, destination: ADDR2, data: 'SEND|0|ALPHA|10|' + ADDR2 }
        ]);

        const count = await processBlocks(indexer);

        assert.strictEqual(count, 4, 'Expected 4 blocks to be processed (incl. gas block)');
        await assertBlockCount(indexerQuery, 4);
    });

    // -----------------------------------------------------------------------
    // 2. Incremental sync: process first batch, then extend with more blocks
    // -----------------------------------------------------------------------
    it('incremental sync picks up new blocks after initial sync', async function () {
        // First batch: 2 blocks
        // Fee era: the ISSUE below needs gas
        await seedGas(seeder, { blockIndex: 199, addresses: [ADDR1, ADDR2, ADDR3] });
        await seeder.seedBlock(200, BASE_TIME, [
            { source: ADDR1, data: 'ISSUE|0|BETA|5000|500|0|Beta token' }
        ]);
        await seeder.seedBlock(201, BASE_TIME + 10, [
            { source: ADDR1, data: 'MINT|0|BETA|100' }
        ]);

        const firstCount = await processBlocks(indexer);
        assert.strictEqual(firstCount, 3, 'Expected 3 blocks in first pass (incl. gas block)');
        await assertBlockCount(indexerQuery, 3);

        // Add 2 more blocks to decoder DB and process again
        await seeder.seedBlock(202, BASE_TIME + 20, [
            { source: ADDR1, data: 'MINT|0|BETA|200' }
        ]);
        await seeder.seedBlock(203, BASE_TIME + 30, [
            { source: ADDR1, destination: ADDR2, data: 'SEND|0|BETA|50|' + ADDR2 }
        ]);

        const secondCount = await processBlocks(indexer);
        assert.strictEqual(secondCount, 2, 'Expected 2 blocks in second pass');
        await assertBlockCount(indexerQuery, 5);
    });

    // -----------------------------------------------------------------------
    // 3. No new blocks: process with no decoder data, verify 0 blocks processed
    // -----------------------------------------------------------------------
    it('returns 0 when decoder DB has no blocks', async function () {
        const count = await processBlocks(indexer);
        assert.strictEqual(count, 0, 'Expected 0 blocks when decoder DB is empty');
        await assertBlockCount(indexerQuery, 0);
    });

    // -----------------------------------------------------------------------
    // 4. Empty block (no transactions): verify block record created with hashes
    // -----------------------------------------------------------------------
    it('processes an empty block and creates a block record with hashes', async function () {
        await seeder.seedBlock(300, BASE_TIME, []); // no transactions

        const count = await processBlocks(indexer);
        assert.strictEqual(count, 1, 'Expected 1 block processed');
        await assertBlockCount(indexerQuery, 1);

        // Block record must have hash IDs set
        const rows = await indexerQuery(
            'SELECT block_index, ledger_hash_id, actions_hash_id FROM blocks WHERE block_index = ?',
            [300]
        );
        assert.strictEqual(rows.length, 1, 'Block record should exist');
        assert.ok(rows[0].ledger_hash_id !== null, 'ledger_hash_id should not be null');
        assert.ok(rows[0].actions_hash_id !== null, 'actions_hash_id should not be null');
    });

    // -----------------------------------------------------------------------
    // 5. Multiple blocks sequential: seed 5 blocks each with 1-3 txs
    // -----------------------------------------------------------------------
    it('processes 5 sequential blocks with varying transaction counts', async function () {
        // Block 400: 1 tx (ISSUE)
        // Fee era: the ISSUE below needs gas
        await seedGas(seeder, { blockIndex: 399, addresses: [ADDR1, ADDR2, ADDR3] });
        await seeder.seedBlock(400, BASE_TIME, [
            { source: ADDR1, data: 'ISSUE|0|GAMMA|10000|1000|0|Gamma token' }
        ]);
        // Block 401: 2 txs (MINT x2)
        await seeder.seedBlock(401, BASE_TIME + 10, [
            { source: ADDR1, data: 'MINT|0|GAMMA|100' },
            { source: ADDR2, data: 'MINT|0|GAMMA|200' }
        ]);
        // Block 402: 3 txs
        await seeder.seedBlock(402, BASE_TIME + 20, [
            { source: ADDR1, data: 'MINT|0|GAMMA|50' },
            { source: ADDR2, data: 'MINT|0|GAMMA|50' },
            { source: ADDR3, data: 'MINT|0|GAMMA|100' }
        ]);
        // Block 403: 1 tx (SEND)
        await seeder.seedBlock(403, BASE_TIME + 30, [
            { source: ADDR1, destination: ADDR2, data: 'SEND|0|GAMMA|10|' + ADDR2 }
        ]);
        // Block 404: empty
        await seeder.seedBlock(404, BASE_TIME + 40, []);

        const count = await processBlocks(indexer);
        assert.strictEqual(count, 6, 'Expected 6 blocks processed (incl. gas block)');
        await assertBlockCount(indexerQuery, 6);
    });

    // -----------------------------------------------------------------------
    // 6. Block hash chain: all blocks have ledger_hash_id and actions_hash_id
    // -----------------------------------------------------------------------
    it('every processed block has ledger and actions hash IDs', async function () {
        // Fee era: the ISSUE below needs gas
        await seedGas(seeder, { blockIndex: 499, addresses: [ADDR1, ADDR2, ADDR3] });
        await seeder.seedBlock(500, BASE_TIME, [
            { source: ADDR1, data: 'ISSUE|0|DELTA|2000|200|0|Delta token' }
        ]);
        await seeder.seedBlock(501, BASE_TIME + 10, [
            { source: ADDR1, data: 'MINT|0|DELTA|100' }
        ]);
        await seeder.seedBlock(502, BASE_TIME + 20, []); // empty block

        await processBlocks(indexer);
        await assertHashChain(indexerQuery);
    });

    // -----------------------------------------------------------------------
    // 7. Transaction atomicity: valid blocks commit correctly
    // -----------------------------------------------------------------------
    it('each block is committed atomically (all state present after processing)', async function () {
        // Fee era: the ISSUE below needs gas
        await seedGas(seeder, { blockIndex: 599, addresses: [ADDR1, ADDR2, ADDR3] });
        await seeder.seedBlock(600, BASE_TIME, [
            { source: ADDR1, data: 'ISSUE|0|EPSILON|3000|300|0|Epsilon token' }
        ]);
        await seeder.seedBlock(601, BASE_TIME + 10, [
            { source: ADDR1, data: 'MINT|0|EPSILON|150' }
        ]);

        const count = await processBlocks(indexer);
        assert.strictEqual(count, 3); // incl. gas block

        // Both blocks should be committed; verify state from both is present
        const tokenRows = await indexerQuery(
            `SELECT t.supply
             FROM tokens t
             INNER JOIN index_tickers it ON it.id = t.tick_id
             WHERE it.tick = 'EPSILON'`
        );
        assert.strictEqual(tokenRows.length, 1, 'Token should exist after commit');
        // Supply from MINT should be reflected
        assert.strictEqual(tokenRows[0].supply, '150', 'Token supply should be 150 after mint');
    });

    // -----------------------------------------------------------------------
    // 8. Action index monotonicity: action_indexes are sequential across blocks
    // -----------------------------------------------------------------------
    it('action_indexes are strictly monotonically increasing across blocks', async function () {
        // Fee era: the ISSUE below needs gas
        await seedGas(seeder, { blockIndex: 699, addresses: [ADDR1, ADDR2, ADDR3] });
        await seeder.seedBlock(700, BASE_TIME, [
            { source: ADDR1, data: 'ISSUE|0|ZETA|5000|500|0|Zeta token' }
        ]);
        await seeder.seedBlock(701, BASE_TIME + 10, [
            { source: ADDR1, data: 'MINT|0|ZETA|100' },
            { source: ADDR2, data: 'MINT|0|ZETA|200' }
        ]);
        await seeder.seedBlock(702, BASE_TIME + 20, [
            { source: ADDR1, destination: ADDR2, data: 'SEND|0|ZETA|50|' + ADDR2 }
        ]);

        await processBlocks(indexer);

        // Fetch all action_indexes in order and verify they are strictly increasing
        const rows = await indexerQuery(
            'SELECT action_index FROM actions ORDER BY action_index ASC'
        );
        assert.ok(rows.length >= 4, 'Expected at least 4 action records');
        for (let i = 1; i < rows.length; i++) {
            const prev = Number(rows[i - 1].action_index);
            const curr = Number(rows[i].action_index);
            assert.ok(curr > prev,
                `action_index not monotone: row ${i - 1} = ${prev}, row ${i} = ${curr}`);
        }
    });

    // -----------------------------------------------------------------------
    // 9. Single block with one transaction: baseline happy path
    // -----------------------------------------------------------------------
    it('processes a single block with one transaction', async function () {
        // Fee era: the ISSUE below needs gas
        await seedGas(seeder, { blockIndex: 799, addresses: [ADDR1, ADDR2, ADDR3] });
        await seeder.seedBlock(800, BASE_TIME, [
            { source: ADDR1, data: 'ISSUE|0|ETA|1000|100|0|Eta token' }
        ]);

        const count = await processBlocks(indexer);
        assert.strictEqual(count, 2); // incl. gas block
        await assertBlockCount(indexerQuery, 2);

        const actionCount = await countRows(indexerQuery, 'actions');
        assert.strictEqual(actionCount, 5, 'Expected exactly 1 action record + 4 gas-preamble actions');
    });

    // -----------------------------------------------------------------------
    // 10. Block with multiple transactions creates multiple action records
    // -----------------------------------------------------------------------
    it('multiple transactions in one block each produce a separate action record', async function () {
        // Fee era: the ISSUE below needs gas
        await seedGas(seeder, { blockIndex: 899, addresses: [ADDR1, ADDR2, ADDR3] });
        await seeder.seedBlock(900, BASE_TIME, [
            { source: ADDR1, data: 'ISSUE|0|THETA|2000|200|0|Theta' },
            { source: ADDR1, data: 'MINT|0|THETA|100' },
            { source: ADDR2, data: 'MINT|0|THETA|100' }
        ]);

        await processBlocks(indexer);
        await assertBlockCount(indexerQuery, 2);

        const actionCount = await countRows(indexerQuery, 'actions');
        assert.strictEqual(actionCount, 7, 'Expected 3 action records from 3 transactions + 4 gas-preamble actions');
    });

    // -----------------------------------------------------------------------
    // 11. Blocks not yet in decoder are not processed by indexer
    // -----------------------------------------------------------------------
    it('indexer does not process blocks beyond what decoder has', async function () {
        // Only seed 2 blocks
        // Fee era: the ISSUE below needs gas
        await seedGas(seeder, { blockIndex: 999, addresses: [ADDR1, ADDR2, ADDR3] });
        await seeder.seedBlock(1000, BASE_TIME, [
            { source: ADDR1, data: 'ISSUE|0|IOTA|1000|100|0|Iota' }
        ]);
        await seeder.seedBlock(1001, BASE_TIME + 10, [
            { source: ADDR1, data: 'MINT|0|IOTA|50' }
        ]);

        const count = await processBlocks(indexer);
        assert.strictEqual(count, 3, 'Should process exactly 3 blocks (incl. gas block)');
        await assertBlockCount(indexerQuery, 3);
    });

    // -----------------------------------------------------------------------
    // 12. Block time is preserved in the indexer blocks table
    // -----------------------------------------------------------------------
    it('block time is stored correctly in the indexer blocks table', async function () {
        const blockTime = 1700005000;
        // Fee era: the ISSUE below needs gas
        await seedGas(seeder, { blockIndex: 1099, addresses: [ADDR1, ADDR2, ADDR3] });
        await seeder.seedBlock(1100, blockTime, [
            { source: ADDR1, data: 'ISSUE|0|KAPPA|500|50|0|Kappa' }
        ]);

        await processBlocks(indexer);

        const rows = await indexerQuery(
            'SELECT block_time FROM blocks WHERE block_index = ?',
            [1100]
        );
        assert.strictEqual(rows.length, 1, 'Block record should exist');
        assert.strictEqual(Number(rows[0].block_time), blockTime,
            `Block time should be ${blockTime}`);
    });
});
