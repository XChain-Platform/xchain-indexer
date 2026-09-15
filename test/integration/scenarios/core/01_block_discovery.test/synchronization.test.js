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
 * Integration tests: Block Discovery and Sync, multi-block synchronization
 *
 * Verifies multi-block sequences, that every block carries ledger and
 * actions hash ids, that each block commits atomically, and that
 * action_index increases strictly across blocks.
 */

'use strict';

const assert = require('assert');
const {
    ADDR1, ADDR2, ADDR3, BASE_TIME, defineBlockDiscoverySuite,
    indexerQuery, processBlocks, seedGas, assertBlockCount, assertHashChain,
} = require('./helpers/suite');

// -----------------------------------------------------------------------
// 5. Multiple blocks sequential: seed 5 blocks each with 1-3 txs
// -----------------------------------------------------------------------
defineBlockDiscoverySuite(__filename, function (state) {
    it('processes 5 sequential blocks with varying transaction counts', async function () {
        const { seeder, indexer } = state;
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
});

// -----------------------------------------------------------------------
// 6. Block hash chain: all blocks have ledger_hash_id and actions_hash_id
// -----------------------------------------------------------------------
defineBlockDiscoverySuite(__filename, function (state) {
    it('every processed block has ledger and actions hash IDs', async function () {
        const { seeder, indexer } = state;
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
});

// -----------------------------------------------------------------------
// 7. Transaction atomicity: valid blocks commit correctly
// -----------------------------------------------------------------------
defineBlockDiscoverySuite(__filename, function (state) {
    it('each block is committed atomically (all state present after processing)', async function () {
        const { seeder, indexer } = state;
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
});

// -----------------------------------------------------------------------
// 8. Action index monotonicity: action_indexes are sequential across blocks
// -----------------------------------------------------------------------
defineBlockDiscoverySuite(__filename, function (state) {
    it('action_indexes are strictly monotonically increasing across blocks', async function () {
        const { seeder, indexer } = state;
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
});
