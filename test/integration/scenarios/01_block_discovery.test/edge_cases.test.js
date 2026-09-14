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
 * Integration tests: Block Discovery and Sync, edge cases
 *
 * Verifies the single-transaction baseline, one action record per
 * transaction, that the indexer never runs past what the decoder has, and
 * that block time is stored as fed.
 */

'use strict';

const assert = require('assert');
const {
    ADDR1, ADDR2, ADDR3, BASE_TIME, defineBlockDiscoverySuite,
    indexerQuery, processBlocks, seedGas, assertBlockCount, countRows,
} = require('./helpers/suite');

// -----------------------------------------------------------------------
// 9. Single block with one transaction: baseline happy path
// -----------------------------------------------------------------------
defineBlockDiscoverySuite(__filename, function (state) {
    it('processes a single block with one transaction', async function () {
        const { seeder, indexer } = state;
        // Fee era: the ISSUE below needs gas
        await seedGas(seeder, { blockIndex: 799, addresses: [ADDR1, ADDR2, ADDR3] });
        await seeder.seedBlock(800, BASE_TIME, [
            { source: ADDR1, data: 'ISSUE|0|ETAX|1000|100|0|Eta token' }
        ]);

        const count = await processBlocks(indexer);
        assert.strictEqual(count, 2); // incl. gas block
        await assertBlockCount(indexerQuery, 2);

        const actionCount = await countRows(indexerQuery, 'actions');
        assert.strictEqual(actionCount, 5, 'Expected exactly 1 action record + 4 gas-preamble actions');
    });
});

// -----------------------------------------------------------------------
// 10. Block with multiple transactions creates multiple action records
// -----------------------------------------------------------------------
defineBlockDiscoverySuite(__filename, function (state) {
    it('multiple transactions in one block each produce a separate action record', async function () {
        const { seeder, indexer } = state;
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
});

// -----------------------------------------------------------------------
// 11. Blocks not yet in decoder are not processed by indexer
// -----------------------------------------------------------------------
defineBlockDiscoverySuite(__filename, function (state) {
    it('indexer does not process blocks beyond what decoder has', async function () {
        const { seeder, indexer } = state;
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
});

// -----------------------------------------------------------------------
// 12. Block time is preserved in the indexer blocks table
// -----------------------------------------------------------------------
defineBlockDiscoverySuite(__filename, function (state) {
    it('block time is stored correctly in the indexer blocks table', async function () {
        const { seeder, indexer } = state;
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
