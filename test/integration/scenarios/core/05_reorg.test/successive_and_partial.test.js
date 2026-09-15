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
 * test/integration/scenarios/core/05_reorg.test/successive_and_partial.test.js
 *
 * Reorg cases beyond one rollback: two successive reorgs, a reorg that must preserve the
 * actions of blocks before its point, and empty replacement blocks.
 *
 * Kept under the entry file's describe title, so every full test title reads as it did
 * when the suite was one file (05_reorg.test.js holds cases 1 to 4 and the reorg test
 * pattern every case follows). The actors, block helper and hooks are in
 * helpers/reorg_chain.js. Needs a disposable MariaDB, like every scenario here.
 */

'use strict';

const assert = require('assert');
const { decoderQuery, indexerQuery } = require('../../../setup/db-connection');
const DecoderSeeder = require('../../../setup/decoder-seeder');
const { initIndexer, processBlocks, destroyIndexer } = require('../../../setup/indexer-launcher');
const { seedGas } = require('../../../setup/gas-seeder');
const helpers = require('../../../setup/assertion-helpers');
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
    // 7. Multiple reorgs: two successive reorgs handled correctly
    // -----------------------------------------------------------------------
    it('7. two successive reorgs converge to correct final state', async function () {
        const seeder = new DecoderSeeder(decoderQuery);
        // Fee era: ISSUEs below need gas; seed XCHAIN to the actors first
        await seedGas(seeder, { blockIndex: 699, addresses: [ADDR1, ADDR2, ADDR3] });

        // Phase 1: four blocks
        await seeder.seedBlock(700, T0,           [{ source: ADDR1, destination: null, amount: '0', data: 'ISSUE|0|DBLX|1000000|1000|0|Double reorg' }]);
        await seeder.seedBlock(701, T0 + BLK,     [{ source: ADDR1, destination: null, amount: '0', data: 'MINT|0|DBLX|1000' }]);
        await seeder.seedBlock(702, T0 + BLK * 2, [{ source: ADDR1, destination: ADDR2, amount: '0', data: 'SEND|0|DBLX|500|' + ADDR2 }]);
        await seeder.seedBlock(703, T0 + BLK * 3, [{ source: ADDR2, destination: ADDR3, amount: '0', data: 'SEND|0|DBLX|200|' + ADDR3 }]);

        let indexer = await initIndexer();
        await processBlocks(indexer);
        await destroyIndexer(indexer);

        // FIRST reorg at 702
        await seeder.seedReorgEvent([702]);
        await deleteDecoderBlocksFrom(702);
        await seeder.seedBlock(702, T0 + BLK * 2, [{ source: ADDR1, destination: ADDR2, amount: '0', data: 'SEND|0|DBLX|300|' + ADDR2 }]);
        await seeder.seedBlock(703, T0 + BLK * 3, [{ source: ADDR2, destination: ADDR3, amount: '0', data: 'SEND|0|DBLX|150|' + ADDR3 }]);

        indexer = await initIndexer();
        await processBlocks(indexer);
        await destroyIndexer(indexer);

        // After first reorg: ADDR1=700, ADDR2=150, ADDR3=150
        await helpers.assertBalance(indexerQuery, ADDR1, 'DBLX', '700');
        await helpers.assertBalance(indexerQuery, ADDR2, 'DBLX', '150');
        await helpers.assertBalance(indexerQuery, ADDR3, 'DBLX', '150');

        // SECOND reorg at 703: undo the last SEND
        await seeder.seedReorgEvent([703]);
        await deleteDecoderBlocksFrom(703);
        await seeder.seedBlock(703, T0 + BLK * 3, [{ source: ADDR1, destination: ADDR3, amount: '0', data: 'SEND|0|DBLX|700|' + ADDR3 }]);

        indexer = await initIndexer();
        await processBlocks(indexer);
        await destroyIndexer(indexer);

        // After second reorg: ADDR1 sent all 700 to ADDR3
        await helpers.assertBalance(indexerQuery, ADDR1, 'DBLX', null); // zero balance (row removed)
        await helpers.assertBalance(indexerQuery, ADDR2, 'DBLX', '300'); // unchanged from post-first-reorg
        await helpers.assertBalance(indexerQuery, ADDR3, 'DBLX', '700');
    });

});

describe('05 – Chain Reorganization @regression @tier3', function () {
    this.timeout(60000);
    before(createFileSchemas);
    after(closeFileSchemas);
    beforeEach(freshChain);

    // -----------------------------------------------------------------------
    // 8. Reorg preserves actions from non-reorged blocks
    // -----------------------------------------------------------------------
    it('8. actions in blocks before reorg point are preserved', async function () {
        const seeder = new DecoderSeeder(decoderQuery);
        // Fee era: ISSUEs below need gas; seed XCHAIN to the actors first
        await seedGas(seeder, { blockIndex: 799, addresses: [ADDR1, ADDR2, ADDR3] });

        // Phase 1
        await seeder.seedBlock(800, T0,           [{ source: ADDR1, destination: null, amount: '0', data: 'ISSUE|0|PRSV|100000|100|0|Preserve test' }]);
        await seeder.seedBlock(801, T0 + BLK,     [{ source: ADDR1, destination: null, amount: '0', data: 'MINT|0|PRSV|100' }]);
        await seeder.seedBlock(802, T0 + BLK * 2, [{ source: ADDR1, destination: ADDR2, amount: '0', data: 'SEND|0|PRSV|50|' + ADDR2 }]);
        await seeder.seedBlock(803, T0 + BLK * 3, [{ source: ADDR2, destination: ADDR1, amount: '0', data: 'SEND|0|PRSV|10|' + ADDR1 }]);

        let indexer = await initIndexer();
        await processBlocks(indexer);
        await destroyIndexer(indexer);

        // Reorg only at 803
        await seeder.seedReorgEvent([803]);
        await deleteDecoderBlocksFrom(803);
        await seeder.seedBlock(803, T0 + BLK * 3, [{ source: ADDR2, destination: ADDR3, amount: '0', data: 'SEND|0|PRSV|20|' + ADDR3 }]);

        indexer = await initIndexer();
        await processBlocks(indexer);
        await destroyIndexer(indexer);

        // Blocks 800-802 preserved: ADDR1=50, ADDR2 sent 20 to ADDR3 → ADDR2=30, ADDR3=20
        await helpers.assertBalance(indexerQuery, ADDR1, 'PRSV', '50');
        await helpers.assertBalance(indexerQuery, ADDR2, 'PRSV', '30');
        await helpers.assertBalance(indexerQuery, ADDR3, 'PRSV', '20');

        // Verify the original ISSUE/MINT actions are still present
        const issueIdx = await helpers.getLastActionIndexByType(indexerQuery, 'ISSUE');
        assert.ok(issueIdx !== null, 'ISSUE action should still exist after partial reorg');
    });

});

describe('05 – Chain Reorganization @regression @tier3', function () {
    this.timeout(60000);
    before(createFileSchemas);
    after(closeFileSchemas);
    beforeEach(freshChain);

    // -----------------------------------------------------------------------
    // 9. Reorg with empty replacement blocks
    // -----------------------------------------------------------------------
    it('9. reorg with empty replacement blocks leaves only pre-reorg data', async function () {
        const seeder = new DecoderSeeder(decoderQuery);
        // Fee era: ISSUEs below need gas; seed XCHAIN to the actors first
        await seedGas(seeder, { blockIndex: 899, addresses: [ADDR1, ADDR2, ADDR3] });

        // Phase 1
        await seeder.seedBlock(900, T0,           [{ source: ADDR1, destination: null, amount: '0', data: 'ISSUE|0|EMPT|500000|500|0|Empty reorg test' }]);
        await seeder.seedBlock(901, T0 + BLK,     [{ source: ADDR1, destination: null, amount: '0', data: 'MINT|0|EMPT|500' }]);
        await seeder.seedBlock(902, T0 + BLK * 2, [{ source: ADDR1, destination: ADDR2, amount: '0', data: 'SEND|0|EMPT|300|' + ADDR2 }]);

        let indexer = await initIndexer();
        await processBlocks(indexer);
        await destroyIndexer(indexer);

        await helpers.assertBalance(indexerQuery, ADDR1, 'EMPT', '200');
        await helpers.assertBalance(indexerQuery, ADDR2, 'EMPT', '300');

        // Phase 2: reorg at 902, replace with empty block
        await seeder.seedReorgEvent([902]);
        await deleteDecoderBlocksFrom(902);
        await seeder.seedBlock(902, T0 + BLK * 2, []); // empty block

        indexer = await initIndexer();
        await processBlocks(indexer);
        await destroyIndexer(indexer);

        // SEND rolled back; ADDR1 has all 500, ADDR2 has nothing
        await helpers.assertBalance(indexerQuery, ADDR1, 'EMPT', '500');
        await helpers.assertBalance(indexerQuery, ADDR2, 'EMPT', null);
        await helpers.assertTokenSupply(indexerQuery, 'EMPT', '500');
        await helpers.assertSanity(indexerQuery, 'EMPT');
    });

});
