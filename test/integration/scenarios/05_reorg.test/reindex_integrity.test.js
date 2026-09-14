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
 * test/integration/scenarios/05_reorg.test/reindex_integrity.test.js
 *
 * Reorg cases that check what a reindex leaves behind: the supply sanity check, a
 * non-null block hash chain, and strictly increasing action indexes.
 *
 * Kept under the entry file's describe title, so every full test title reads as it did
 * when the suite was one file (05_reorg.test.js holds cases 1 to 4 and the reorg test
 * pattern every case follows). The actors, block helper and hooks are in
 * helpers/reorg_chain.js. Needs a disposable MariaDB, like every scenario here.
 */

'use strict';

const assert = require('assert');
const { decoderQuery, indexerQuery } = require('../../setup/db-connection');
const DecoderSeeder = require('../../setup/decoder-seeder');
const { initIndexer, processBlocks, destroyIndexer } = require('../../setup/indexer-launcher');
const { seedGas } = require('../../setup/gas-seeder');
const helpers = require('../../setup/assertion-helpers');
const { ADDR1, ADDR2, ADDR3, T0, BLK, deleteDecoderBlocksFrom, fileSchemaHooks, freshChain } = require('./helpers/reorg_chain');

// The three hooks every block of 05_reorg.test.js registers, bound to this file's own
// scoped schemas.
const { createFileSchemas, closeFileSchemas } = fileSchemaHooks(__filename);

describe('05 – Chain Reorganization @regression @tier3', function () {
    this.timeout(60000);
    before(createFileSchemas);
    after(closeFileSchemas);
    beforeEach(freshChain);

    // -----------------------------------------------------------------------
    // 5. Sanity check passes after reorg: supply consistency after rollback
    // -----------------------------------------------------------------------
    it('5. sanity check passes after rollback and reindex', async function () {
        const seeder = new DecoderSeeder(decoderQuery);
        // Fee era: ISSUEs below need gas; seed XCHAIN to the actors first
        await seedGas(seeder, { blockIndex: 499, addresses: [ADDR1, ADDR2, ADDR3] });

        // Phase 1
        await seeder.seedBlock(500, T0,           [{ source: ADDR1, destination: null, amount: '0', data: 'ISSUE|0|SANX|2000000|500|0|Sanity check' }]);
        await seeder.seedBlock(501, T0 + BLK,     [{ source: ADDR1, destination: null, amount: '0', data: 'MINT|0|SANX|500' }]);
        await seeder.seedBlock(502, T0 + BLK * 2, [
            { source: ADDR1, destination: ADDR2, amount: '0', data: 'SEND|0|SANX|100|' + ADDR2 },
        ]);
        await seeder.seedBlock(503, T0 + BLK * 3, [{ source: ADDR1, destination: null, amount: '0', data: 'MINT|0|SANX|300' }]);

        let indexer = await initIndexer();
        await processBlocks(indexer);
        await destroyIndexer(indexer);

        // Phase 2: reorg at 502, remove the SEND
        await seeder.seedReorgEvent([502]);
        await deleteDecoderBlocksFrom(502);
        await seeder.seedBlock(502, T0 + BLK * 2, [{ source: ADDR1, destination: null, amount: '0', data: 'MINT|0|SANX|200' }]);
        await seeder.seedBlock(503, T0 + BLK * 3, [{ source: ADDR1, destination: ADDR3, amount: '0', data: 'SEND|0|SANX|50|' + ADDR3 }]);

        // Phase 3
        indexer = await initIndexer();
        await processBlocks(indexer);
        await destroyIndexer(indexer);

        // Phase 4: supply = 500 + 200 = 700; ADDR1 = 700-50 = 650, ADDR3 = 50
        await helpers.assertTokenSupply(indexerQuery, 'SANX', '700');
        await helpers.assertBalance(indexerQuery, ADDR1, 'SANX', '650');
        await helpers.assertBalance(indexerQuery, ADDR3, 'SANX', '50');

        // Full sanity check: ledger consistency
        await helpers.assertSanity(indexerQuery, 'SANX');
    });

});

describe('05 – Chain Reorganization @regression @tier3', function () {
    this.timeout(60000);
    before(createFileSchemas);
    after(closeFileSchemas);
    beforeEach(freshChain);

    // -----------------------------------------------------------------------
    // 6. Block hash chain is valid (non-null) after reorg and reindex
    // -----------------------------------------------------------------------
    it('6. block hash chain is valid and non-null after reorg', async function () {
        const seeder = new DecoderSeeder(decoderQuery);
        // Fee era: ISSUEs below need gas; seed XCHAIN to the actors first
        await seedGas(seeder, { blockIndex: 599, addresses: [ADDR1, ADDR2, ADDR3] });

        // Phase 1
        await seeder.seedBlock(600, T0,           [{ source: ADDR1, destination: null, amount: '0', data: 'ISSUE|0|HASH|500000|500|0|Hash chain test' }]);
        await seeder.seedBlock(601, T0 + BLK,     [{ source: ADDR1, destination: null, amount: '0', data: 'MINT|0|HASH|500' }]);
        await seeder.seedBlock(602, T0 + BLK * 2, [{ source: ADDR1, destination: ADDR2, amount: '0', data: 'SEND|0|HASH|100|' + ADDR2 }]);
        await seeder.seedBlock(603, T0 + BLK * 3, [{ source: ADDR1, destination: null, amount: '0', data: 'MINT|0|HASH|200' }]);

        let indexer = await initIndexer();
        await processBlocks(indexer);
        await destroyIndexer(indexer);

        // Phase 2: reorg at 602
        await seeder.seedReorgEvent([602]);
        await deleteDecoderBlocksFrom(602);
        await seeder.seedBlock(602, T0 + BLK * 2, [{ source: ADDR1, destination: null, amount: '0', data: 'MINT|0|HASH|50' }]);
        await seeder.seedBlock(603, T0 + BLK * 3, [{ source: ADDR1, destination: ADDR2, amount: '0', data: 'SEND|0|HASH|25|' + ADDR2 }]);
        await seeder.seedBlock(604, T0 + BLK * 4, [{ source: ADDR2, destination: null, amount: '0', data: 'MINT|0|HASH|100' }]);

        // Phase 3
        indexer = await initIndexer();
        await processBlocks(indexer);
        await destroyIndexer(indexer);

        // Phase 4: all blocks must have non-null ledger and actions hashes
        await helpers.assertHashChain(indexerQuery);
        await helpers.assertBlockCount(indexerQuery, 6); // 600-604
    });

});

describe('05 – Chain Reorganization @regression @tier3', function () {
    this.timeout(60000);
    before(createFileSchemas);
    after(closeFileSchemas);
    beforeEach(freshChain);

    // -----------------------------------------------------------------------
    // 10. Action indexes are monotonically increasing after reorg + reindex
    // -----------------------------------------------------------------------
    it('10. action_indexes are monotonically increasing after reorg', async function () {
        const seeder = new DecoderSeeder(decoderQuery);
        // Fee era: ISSUEs below need gas; seed XCHAIN to the actors first
        await seedGas(seeder, { blockIndex: 999, addresses: [ADDR1, ADDR2, ADDR3] });

        // Phase 1
        await seeder.seedBlock(1000, T0,           [{ source: ADDR1, destination: null, amount: '0', data: 'ISSUE|0|MONO|1000000|1000|0|Monotonic test' }]);
        await seeder.seedBlock(1001, T0 + BLK,     [{ source: ADDR1, destination: null, amount: '0', data: 'MINT|0|MONO|500' }]);
        await seeder.seedBlock(1002, T0 + BLK * 2, [{ source: ADDR1, destination: ADDR2, amount: '0', data: 'SEND|0|MONO|100|' + ADDR2 }]);
        await seeder.seedBlock(1003, T0 + BLK * 3, [{ source: ADDR1, destination: ADDR2, amount: '0', data: 'SEND|0|MONO|100|' + ADDR2 }]);

        let indexer = await initIndexer();
        await processBlocks(indexer);
        await destroyIndexer(indexer);

        // Phase 2: reorg at 1002
        await seeder.seedReorgEvent([1002]);
        await deleteDecoderBlocksFrom(1002);
        await seeder.seedBlock(1002, T0 + BLK * 2, [{ source: ADDR1, destination: ADDR3, amount: '0', data: 'SEND|0|MONO|200|' + ADDR3 }]);
        await seeder.seedBlock(1003, T0 + BLK * 3, [{ source: ADDR1, destination: ADDR3, amount: '0', data: 'SEND|0|MONO|100|' + ADDR3 }]);

        indexer = await initIndexer();
        await processBlocks(indexer);
        await destroyIndexer(indexer);

        // Verify all action_indexes are strictly increasing
        const rows = await indexerQuery(
            'SELECT action_index FROM actions ORDER BY action_index ASC'
        );
        assert.ok(rows.length >= 4, 'Should have at least 4 action records');
        for (let i = 1; i < rows.length; i++) {
            const prev = Number(rows[i - 1].action_index);
            const curr = Number(rows[i].action_index);
            assert.ok(curr > prev,
                `action_index not strictly increasing: ${prev} then ${curr}`);
        }
    });
});
