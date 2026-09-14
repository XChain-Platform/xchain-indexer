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
const {
    ADDR1, ADDR2, ADDR3, BASE_TIME, defineBlockDiscoverySuite,
    indexerQuery, processBlocks, seedGas, assertBlockCount,
} = require('./01_block_discovery.test/helpers/suite');

// -----------------------------------------------------------------------
// 1. Initial sync from empty state: seed 3 blocks, verify all processed
// -----------------------------------------------------------------------
defineBlockDiscoverySuite(__filename, function (state) {
    it('initial sync processes all seeded blocks', async function () {
        const { seeder, indexer } = state;
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
});

// -----------------------------------------------------------------------
// 2. Incremental sync: process first batch, then extend with more blocks
// -----------------------------------------------------------------------
defineBlockDiscoverySuite(__filename, function (state) {
    it('incremental sync picks up new blocks after initial sync', async function () {
        const { seeder, indexer } = state;
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
});

// -----------------------------------------------------------------------
// 3. No new blocks: process with no decoder data, verify 0 blocks processed
// -----------------------------------------------------------------------
defineBlockDiscoverySuite(__filename, function (state) {
    it('returns 0 when decoder DB has no blocks', async function () {
        const { indexer } = state;
        const count = await processBlocks(indexer);
        assert.strictEqual(count, 0, 'Expected 0 blocks when decoder DB is empty');
        await assertBlockCount(indexerQuery, 0);
    });
});

// -----------------------------------------------------------------------
// 4. Empty block (no transactions): verify block record created with hashes
// -----------------------------------------------------------------------
defineBlockDiscoverySuite(__filename, function (state) {
    it('processes an empty block and creates a block record with hashes', async function () {
        const { seeder, indexer } = state;
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
});
