'use strict';

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
 * Integration tests - 05: Chain Reorganization handling
 *
 * Tests that the indexer correctly detects reorg events from the decoder DB,
 * rolls back affected state, and re-indexes replacement blocks.
 *
 * Reorg test pattern:
 *   Phase 1 – Seed initial blocks and process them.
 *   Phase 2 – Destroy indexer, seed reorg event, delete old decoder blocks,
 *              seed replacement blocks.
 *   Phase 3 – Init new indexer and processBlocks (detects reorg, rolls back,
 *              reprocesses replacement blocks).
 *   Phase 4 – Assert the final indexer state reflects replacement data only.
 *
 * Cases 5, 6 and 10 live in 05_reorg.test/reindex_integrity.test.js and cases 7 to 9 in
 * 05_reorg.test/successive_and_partial.test.js, under this file's describe title; the
 * actors, block helper and hooks are in 05_reorg.test/helpers/reorg_chain.js.
 */

const assert = require('assert');
const { decoderQuery, indexerQuery } = require('../setup/db-connection');
const DecoderSeeder = require('../setup/decoder-seeder');
const { initIndexer, processBlocks, destroyIndexer } = require('../setup/indexer-launcher');
const { seedGas } = require('../setup/gas-seeder');
const helpers = require('../setup/assertion-helpers');
const { ADDR1, ADDR2, ADDR3, T0, BLK, deleteDecoderBlocksFrom, fileSchemaHooks, freshChain } = require('./05_reorg.test/helpers/reorg_chain');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// The scenario is written as consecutive blocks that all carry the same describe title, so
// no block exceeds the readability limit while every full test title stays what it was.
// Every block registers the same three hooks, so each test still runs under all of them;
// the bodies live once, in the helper named below. The hooks are passed by name rather than wrapped, so `this`
// is still the mocha context and their own timeouts still apply.
// Their bodies live in 05_reorg.test/helpers/reorg_chain.js, shared with the parts beside
// this file; this file's own scoped schemas are bound here.
const { createFileSchemas, closeFileSchemas } = fileSchemaHooks(__filename);

describe('05 – Chain Reorganization @regression @tier3', function () {
    this.timeout(60000);
    before(createFileSchemas);
    after(closeFileSchemas);
    beforeEach(freshChain);

    // -----------------------------------------------------------------------
    // 1. Simple reorg: 5 blocks indexed, reorg to block 102, verify rollback
    // -----------------------------------------------------------------------
    it('1. simple reorg removes blocks above reorg point', async function () {
        const seeder = new DecoderSeeder(decoderQuery);
        // Fee era: ISSUEs below need gas; seed XCHAIN to the actors first
        await seedGas(seeder, { blockIndex: 99, addresses: [ADDR1, ADDR2, ADDR3] });

        // Phase 1: seed five blocks with ISSUE and MINTs, then process
        await seeder.seedBlock(100, T0,           [{ source: ADDR1, destination: null, amount: '0', data: 'ISSUE|0|RORG|1000000|1000|0|Simple reorg test' }]);
        await seeder.seedBlock(101, T0 + BLK,     [{ source: ADDR1, destination: null, amount: '0', data: 'MINT|0|RORG|100' }]);
        await seeder.seedBlock(102, T0 + BLK * 2, [{ source: ADDR1, destination: null, amount: '0', data: 'MINT|0|RORG|200' }]);
        await seeder.seedBlock(103, T0 + BLK * 3, [{ source: ADDR1, destination: null, amount: '0', data: 'MINT|0|RORG|300' }]);
        await seeder.seedBlock(104, T0 + BLK * 4, [{ source: ADDR1, destination: null, amount: '0', data: 'MINT|0|RORG|400' }]);

        let indexer = await initIndexer();
        const processed = await processBlocks(indexer);
        assert.strictEqual(processed, 6, 'Should process 6 initial blocks');
        await destroyIndexer(indexer);

        // Sanity-check pre-reorg state: supply = 100+200+300+400 = 1000
        await helpers.assertTokenSupply(indexerQuery, 'RORG', '1000');
        await helpers.assertBlockCount(indexerQuery, 6);

        // Phase 2: seed reorg at block 102, delete 102-104, seed replacement blocks
        await seeder.seedReorgEvent([102]);
        await deleteDecoderBlocksFrom(102);
        // Replacement: only one MINT of 50 in block 102; blocks 103-104 omitted
        await seeder.seedBlock(102, T0 + BLK * 2, [{ source: ADDR1, destination: null, amount: '0', data: 'MINT|0|RORG|50' }]);

        // Phase 3: new indexer detects reorg, rolls back to 101, reprocesses 102
        indexer = await initIndexer();
        await processBlocks(indexer);
        await destroyIndexer(indexer);

        // Phase 4: blocks 103-104 gone; supply = 100 + 200 (from block 101 mint). Recalculate:
        // block 100: ISSUE (supply 0 at rest), block 101: MINT 100 → supply 100
        // Reorg at 102 → rollback removes block 102+ actions → supply back to 100
        // Replacement block 102: MINT 50 → supply 150
        await helpers.assertTokenSupply(indexerQuery, 'RORG', '150');
        await helpers.assertBlockCount(indexerQuery, 4); // blocks 100, 101, 102
    });

});

describe('05 – Chain Reorganization @regression @tier3', function () {
    this.timeout(60000);
    before(createFileSchemas);
    after(closeFileSchemas);
    beforeEach(freshChain);

    // -----------------------------------------------------------------------
    // 2. Reorg with balance changes: SEND in reorged block reverted
    // -----------------------------------------------------------------------
    it('2. reorg reverts balance changes from rolled-back blocks', async function () {
        const seeder = new DecoderSeeder(decoderQuery);
        // Fee era: ISSUEs below need gas; seed XCHAIN to the actors first
        await seedGas(seeder, { blockIndex: 199, addresses: [ADDR1, ADDR2, ADDR3] });

        // Phase 1
        await seeder.seedBlock(200, T0,           [{ source: ADDR1, destination: null, amount: '0', data: 'ISSUE|0|BREV|1000000|500|0|Balance revert' }]);
        await seeder.seedBlock(201, T0 + BLK,     [{ source: ADDR1, destination: null, amount: '0', data: 'MINT|0|BREV|500' }]);
        await seeder.seedBlock(202, T0 + BLK * 2, [{ source: ADDR1, destination: ADDR2, amount: '0', data: 'SEND|0|BREV|200|' + ADDR2 }]);

        let indexer = await initIndexer();
        await processBlocks(indexer);
        await destroyIndexer(indexer);

        // Pre-reorg: ADDR1 has 300, ADDR2 has 200
        await helpers.assertBalance(indexerQuery, ADDR1, 'BREV', '300');
        await helpers.assertBalance(indexerQuery, ADDR2, 'BREV', '200');

        // Phase 2: reorg at block 202 (removes the SEND)
        await seeder.seedReorgEvent([202]);
        await deleteDecoderBlocksFrom(202);
        // Replacement block 202: no SEND, just a harmless MINT
        await seeder.seedBlock(202, T0 + BLK * 2, [{ source: ADDR1, destination: null, amount: '0', data: 'MINT|0|BREV|100' }]);

        // Phase 3
        indexer = await initIndexer();
        await processBlocks(indexer);
        await destroyIndexer(indexer);

        // Phase 4: SEND was rolled back; ADDR2 should have 0 (no row), ADDR1 has 500+100=600
        await helpers.assertBalance(indexerQuery, ADDR1, 'BREV', '600');
        await helpers.assertBalance(indexerQuery, ADDR2, 'BREV', null); // no balance row
    });

});

describe('05 – Chain Reorganization @regression @tier3', function () {
    this.timeout(60000);
    before(createFileSchemas);
    after(closeFileSchemas);
    beforeEach(freshChain);

    // -----------------------------------------------------------------------
    // 3. Reorg replaces data: replacement blocks have DIFFERENT sends
    // -----------------------------------------------------------------------
    it('3. replacement blocks after reorg produce correct final balances', async function () {
        const seeder = new DecoderSeeder(decoderQuery);
        // Fee era: ISSUEs below need gas; seed XCHAIN to the actors first
        await seedGas(seeder, { blockIndex: 299, addresses: [ADDR1, ADDR2, ADDR3] });

        // Phase 1: ISSUE + MINT + SEND to ADDR2
        await seeder.seedBlock(300, T0,           [{ source: ADDR1, destination: null, amount: '0', data: 'ISSUE|0|RPLD|1000000|1000|0|Replace test' }]);
        await seeder.seedBlock(301, T0 + BLK,     [{ source: ADDR1, destination: null, amount: '0', data: 'MINT|0|RPLD|1000' }]);
        await seeder.seedBlock(302, T0 + BLK * 2, [{ source: ADDR1, destination: ADDR2, amount: '0', data: 'SEND|0|RPLD|400|' + ADDR2 }]);
        await seeder.seedBlock(303, T0 + BLK * 3, [{ source: ADDR1, destination: ADDR3, amount: '0', data: 'SEND|0|RPLD|100|' + ADDR3 }]);

        let indexer = await initIndexer();
        await processBlocks(indexer);
        await destroyIndexer(indexer);

        // Pre-reorg: ADDR1=500, ADDR2=400, ADDR3=100
        await helpers.assertBalance(indexerQuery, ADDR1, 'RPLD', '500');
        await helpers.assertBalance(indexerQuery, ADDR2, 'RPLD', '400');
        await helpers.assertBalance(indexerQuery, ADDR3, 'RPLD', '100');

        // Phase 2: reorg at 302; replacement sends go to ADDR3 instead
        await seeder.seedReorgEvent([302]);
        await deleteDecoderBlocksFrom(302);
        await seeder.seedBlock(302, T0 + BLK * 2, [{ source: ADDR1, destination: ADDR3, amount: '0', data: 'SEND|0|RPLD|750|' + ADDR3 }]);
        await seeder.seedBlock(303, T0 + BLK * 3, [{ source: ADDR1, destination: ADDR2, amount: '0', data: 'SEND|0|RPLD|50|' + ADDR2 }]);

        // Phase 3
        indexer = await initIndexer();
        await processBlocks(indexer);
        await destroyIndexer(indexer);

        // Phase 4: replacement sends: ADDR1=1000-750-50=200, ADDR2=50, ADDR3=750
        await helpers.assertBalance(indexerQuery, ADDR1, 'RPLD', '200');
        await helpers.assertBalance(indexerQuery, ADDR2, 'RPLD', '50');
        await helpers.assertBalance(indexerQuery, ADDR3, 'RPLD', '750');
    });

});

describe('05 – Chain Reorganization @regression @tier3', function () {
    this.timeout(60000);
    before(createFileSchemas);
    after(closeFileSchemas);
    beforeEach(freshChain);

    // -----------------------------------------------------------------------
    // 4. Reorg to first block (effectively clears all indexed data)
    // -----------------------------------------------------------------------
    it('4. reorg to first block clears all subsequent state', async function () {
        const seeder = new DecoderSeeder(decoderQuery);
        // Fee era: ISSUEs below need gas; seed XCHAIN to the actors first
        await seedGas(seeder, { blockIndex: 399, addresses: [ADDR1, ADDR2, ADDR3] });

        // Phase 1: three blocks
        await seeder.seedBlock(400, T0,           [{ source: ADDR1, destination: null, amount: '0', data: 'ISSUE|0|CLRX|500000|500|0|Clear test' }]);
        await seeder.seedBlock(401, T0 + BLK,     [{ source: ADDR1, destination: null, amount: '0', data: 'MINT|0|CLRX|500' }]);
        await seeder.seedBlock(402, T0 + BLK * 2, [{ source: ADDR1, destination: ADDR2, amount: '0', data: 'SEND|0|CLRX|250|' + ADDR2 }]);

        let indexer = await initIndexer();
        await processBlocks(indexer);
        await destroyIndexer(indexer);

        await helpers.assertBlockCount(indexerQuery, 4);

        // Phase 2: reorg at first block (400), deletes everything from 400 onwards,
        // then seeds a completely different block 400
        await seeder.seedReorgEvent([400]);
        await deleteDecoderBlocksFrom(400);
        await seeder.seedBlock(400, T0, [{ source: ADDR2, destination: null, amount: '0', data: 'ISSUE|0|NEWX|100000|100|0|New token' }]);

        // Phase 3
        indexer = await initIndexer();
        await processBlocks(indexer);
        await destroyIndexer(indexer);

        // Phase 4: CLRX token should be gone; NEWX token exists; only 1 block
        const clrToken = await helpers.getToken(indexerQuery, 'CLRX');
        assert.strictEqual(clrToken, null, 'CLRX token should not exist after full reorg');

        const newToken = await helpers.getToken(indexerQuery, 'NEWX');
        assert.ok(newToken !== null, 'NEWX token should exist after reorg replacement');

        await helpers.assertBlockCount(indexerQuery, 2);
    });

});
