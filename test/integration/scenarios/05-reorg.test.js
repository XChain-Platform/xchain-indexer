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
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Integration tests — 05: Chain Reorganization handling
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
 */

const assert = require('assert');
const {
    decoderQuery, indexerQuery,
    createDatabases, createDecoderSchema,
    resetDecoderDb, resetIndexerDb, closeAll,
} = require('../setup/db-connection');
const DecoderSeeder = require('../setup/decoder-seeder');
const { initIndexer, processBlocks, destroyIndexer } = require('../setup/indexer-launcher');
const helpers = require('../setup/assertion-helpers');

// ---------------------------------------------------------------------------
// Addresses — 30-char strings, safe for the indexer's address validation
// ---------------------------------------------------------------------------
const ADDR1 = 'msK1rsgNVFPM4cR3X5rngczTKa6EtT4WKD';
const ADDR2 = 'mjifPngDYQ6HHPNQdGk1kQuFkJWEiQksQp';
const ADDR3 = 'mwGujTXFXMLN2YXqo4mQK4DcKy31DUcwoi';

// Base block time (Unix timestamp)
const T0 = 1700000000;
const BLK = 600; // seconds per block

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Delete decoder blocks >= blockIndex (and their transactions / outputs).
 * Call this after seeding a reorg event but before seeding replacement blocks.
 */
async function deleteDecoderBlocksFrom(blockIndex) {
    await decoderQuery(
        'DELETE FROM transaction_outputs WHERE tx_index IN ' +
        '(SELECT tx_index FROM transactions WHERE block_index >= ?)',
        [blockIndex]
    );
    await decoderQuery('DELETE FROM transactions WHERE block_index >= ?', [blockIndex]);
    await decoderQuery('DELETE FROM blocks WHERE block_index >= ?', [blockIndex]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('05 – Chain Reorganization @regression @tier3', function () {
    this.timeout(60000);

    before(async function () {
        this.timeout(30000);
        await createDatabases();
        await createDecoderSchema();
    });

    after(async function () {
        await closeAll();
    });

    beforeEach(async function () {
        this.timeout(15000);
        await resetDecoderDb();
        await resetIndexerDb();
    });

    // -----------------------------------------------------------------------
    // 1. Simple reorg — 5 blocks indexed, reorg to block 102, verify rollback
    // -----------------------------------------------------------------------
    it('1. simple reorg removes blocks above reorg point', async function () {
        const seeder = new DecoderSeeder(decoderQuery);

        // Phase 1: seed five blocks with ISSUE and MINTs, then process
        await seeder.seedBlock(100, T0,           [{ source: ADDR1, destination: null, amount: '0', data: 'ISSUE|0|RORG|1000000|1000|0|Simple reorg test' }]);
        await seeder.seedBlock(101, T0 + BLK,     [{ source: ADDR1, destination: null, amount: '0', data: 'MINT|0|RORG|100' }]);
        await seeder.seedBlock(102, T0 + BLK * 2, [{ source: ADDR1, destination: null, amount: '0', data: 'MINT|0|RORG|200' }]);
        await seeder.seedBlock(103, T0 + BLK * 3, [{ source: ADDR1, destination: null, amount: '0', data: 'MINT|0|RORG|300' }]);
        await seeder.seedBlock(104, T0 + BLK * 4, [{ source: ADDR1, destination: null, amount: '0', data: 'MINT|0|RORG|400' }]);

        let indexer = await initIndexer();
        const processed = await processBlocks(indexer);
        assert.strictEqual(processed, 5, 'Should process 5 initial blocks');
        await destroyIndexer(indexer);

        // Sanity-check pre-reorg state: supply = 100+200+300+400 = 1000
        await helpers.assertTokenSupply(indexerQuery, 'RORG', '1000');
        await helpers.assertBlockCount(indexerQuery, 5);

        // Phase 2: seed reorg at block 102, delete 102-104, seed replacement blocks
        await seeder.seedReorgEvent([102]);
        await deleteDecoderBlocksFrom(102);
        // Replacement: only one MINT of 50 in block 102; blocks 103-104 omitted
        await seeder.seedBlock(102, T0 + BLK * 2, [{ source: ADDR1, destination: null, amount: '0', data: 'MINT|0|RORG|50' }]);

        // Phase 3: new indexer detects reorg, rolls back to 101, reprocesses 102
        indexer = await initIndexer();
        await processBlocks(indexer);
        await destroyIndexer(indexer);

        // Phase 4: blocks 103-104 gone; supply = 100 + 200 (from block 101 mint) — wait, let's recalculate:
        // block 100: ISSUE (supply 0 at rest), block 101: MINT 100 → supply 100
        // Reorg at 102 → rollback removes block 102+ actions → supply back to 100
        // Replacement block 102: MINT 50 → supply 150
        await helpers.assertTokenSupply(indexerQuery, 'RORG', '150');
        await helpers.assertBlockCount(indexerQuery, 3); // blocks 100, 101, 102
    });

    // -----------------------------------------------------------------------
    // 2. Reorg with balance changes — SEND in reorged block reverted
    // -----------------------------------------------------------------------
    it('2. reorg reverts balance changes from rolled-back blocks', async function () {
        const seeder = new DecoderSeeder(decoderQuery);

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

    // -----------------------------------------------------------------------
    // 3. Reorg replaces data — replacement blocks have DIFFERENT sends
    // -----------------------------------------------------------------------
    it('3. replacement blocks after reorg produce correct final balances', async function () {
        const seeder = new DecoderSeeder(decoderQuery);

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

        // Phase 2: reorg at 302 — replacement sends go to ADDR3 instead
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

    // -----------------------------------------------------------------------
    // 4. Reorg to first block — effectively clears all indexed data
    // -----------------------------------------------------------------------
    it('4. reorg to first block clears all subsequent state', async function () {
        const seeder = new DecoderSeeder(decoderQuery);

        // Phase 1: three blocks
        await seeder.seedBlock(400, T0,           [{ source: ADDR1, destination: null, amount: '0', data: 'ISSUE|0|CLR|500000|500|0|Clear test' }]);
        await seeder.seedBlock(401, T0 + BLK,     [{ source: ADDR1, destination: null, amount: '0', data: 'MINT|0|CLR|500' }]);
        await seeder.seedBlock(402, T0 + BLK * 2, [{ source: ADDR1, destination: ADDR2, amount: '0', data: 'SEND|0|CLR|250|' + ADDR2 }]);

        let indexer = await initIndexer();
        await processBlocks(indexer);
        await destroyIndexer(indexer);

        await helpers.assertBlockCount(indexerQuery, 3);

        // Phase 2: reorg at first block (400) — deletes everything from 400 onwards,
        // then seeds a completely different block 400
        await seeder.seedReorgEvent([400]);
        await deleteDecoderBlocksFrom(400);
        await seeder.seedBlock(400, T0, [{ source: ADDR2, destination: null, amount: '0', data: 'ISSUE|0|NEW|100000|100|0|New token' }]);

        // Phase 3
        indexer = await initIndexer();
        await processBlocks(indexer);
        await destroyIndexer(indexer);

        // Phase 4: CLR token should be gone; NEW token exists; only 1 block
        const clrToken = await helpers.getToken(indexerQuery, 'CLR');
        assert.strictEqual(clrToken, null, 'CLR token should not exist after full reorg');

        const newToken = await helpers.getToken(indexerQuery, 'NEW');
        assert.ok(newToken !== null, 'NEW token should exist after reorg replacement');

        await helpers.assertBlockCount(indexerQuery, 1);
    });

    // -----------------------------------------------------------------------
    // 5. Sanity check passes after reorg — supply consistency after rollback
    // -----------------------------------------------------------------------
    it('5. sanity check passes after rollback and reindex', async function () {
        const seeder = new DecoderSeeder(decoderQuery);

        // Phase 1
        await seeder.seedBlock(500, T0,           [{ source: ADDR1, destination: null, amount: '0', data: 'ISSUE|0|SAN|2000000|500|0|Sanity check' }]);
        await seeder.seedBlock(501, T0 + BLK,     [{ source: ADDR1, destination: null, amount: '0', data: 'MINT|0|SAN|500' }]);
        await seeder.seedBlock(502, T0 + BLK * 2, [
            { source: ADDR1, destination: ADDR2, amount: '0', data: 'SEND|0|SAN|100|' + ADDR2 },
        ]);
        await seeder.seedBlock(503, T0 + BLK * 3, [{ source: ADDR1, destination: null, amount: '0', data: 'MINT|0|SAN|300' }]);

        let indexer = await initIndexer();
        await processBlocks(indexer);
        await destroyIndexer(indexer);

        // Phase 2: reorg at 502, remove the SEND
        await seeder.seedReorgEvent([502]);
        await deleteDecoderBlocksFrom(502);
        await seeder.seedBlock(502, T0 + BLK * 2, [{ source: ADDR1, destination: null, amount: '0', data: 'MINT|0|SAN|200' }]);
        await seeder.seedBlock(503, T0 + BLK * 3, [{ source: ADDR1, destination: ADDR3, amount: '0', data: 'SEND|0|SAN|50|' + ADDR3 }]);

        // Phase 3
        indexer = await initIndexer();
        await processBlocks(indexer);
        await destroyIndexer(indexer);

        // Phase 4: supply = 500 + 200 = 700; ADDR1 = 700-50 = 650, ADDR3 = 50
        await helpers.assertTokenSupply(indexerQuery, 'SAN', '700');
        await helpers.assertBalance(indexerQuery, ADDR1, 'SAN', '650');
        await helpers.assertBalance(indexerQuery, ADDR3, 'SAN', '50');

        // Full sanity check: ledger consistency
        await helpers.assertSanity(indexerQuery, 'SAN');
    });

    // -----------------------------------------------------------------------
    // 6. Block hash chain is valid (non-null) after reorg and reindex
    // -----------------------------------------------------------------------
    it('6. block hash chain is valid and non-null after reorg', async function () {
        const seeder = new DecoderSeeder(decoderQuery);

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
        await helpers.assertBlockCount(indexerQuery, 5); // 600-604
    });

    // -----------------------------------------------------------------------
    // 7. Multiple reorgs — two successive reorgs handled correctly
    // -----------------------------------------------------------------------
    it('7. two successive reorgs converge to correct final state', async function () {
        const seeder = new DecoderSeeder(decoderQuery);

        // Phase 1: four blocks
        await seeder.seedBlock(700, T0,           [{ source: ADDR1, destination: null, amount: '0', data: 'ISSUE|0|DBL|1000000|1000|0|Double reorg' }]);
        await seeder.seedBlock(701, T0 + BLK,     [{ source: ADDR1, destination: null, amount: '0', data: 'MINT|0|DBL|1000' }]);
        await seeder.seedBlock(702, T0 + BLK * 2, [{ source: ADDR1, destination: ADDR2, amount: '0', data: 'SEND|0|DBL|500|' + ADDR2 }]);
        await seeder.seedBlock(703, T0 + BLK * 3, [{ source: ADDR2, destination: ADDR3, amount: '0', data: 'SEND|0|DBL|200|' + ADDR3 }]);

        let indexer = await initIndexer();
        await processBlocks(indexer);
        await destroyIndexer(indexer);

        // FIRST reorg at 702
        await seeder.seedReorgEvent([702]);
        await deleteDecoderBlocksFrom(702);
        await seeder.seedBlock(702, T0 + BLK * 2, [{ source: ADDR1, destination: ADDR2, amount: '0', data: 'SEND|0|DBL|300|' + ADDR2 }]);
        await seeder.seedBlock(703, T0 + BLK * 3, [{ source: ADDR2, destination: ADDR3, amount: '0', data: 'SEND|0|DBL|150|' + ADDR3 }]);

        indexer = await initIndexer();
        await processBlocks(indexer);
        await destroyIndexer(indexer);

        // After first reorg: ADDR1=700, ADDR2=150, ADDR3=150
        await helpers.assertBalance(indexerQuery, ADDR1, 'DBL', '700');
        await helpers.assertBalance(indexerQuery, ADDR2, 'DBL', '150');
        await helpers.assertBalance(indexerQuery, ADDR3, 'DBL', '150');

        // SECOND reorg at 703 — undo the last SEND
        await seeder.seedReorgEvent([703]);
        await deleteDecoderBlocksFrom(703);
        await seeder.seedBlock(703, T0 + BLK * 3, [{ source: ADDR1, destination: ADDR3, amount: '0', data: 'SEND|0|DBL|700|' + ADDR3 }]);

        indexer = await initIndexer();
        await processBlocks(indexer);
        await destroyIndexer(indexer);

        // After second reorg: ADDR1 sent all 700 to ADDR3
        await helpers.assertBalance(indexerQuery, ADDR1, 'DBL', null); // zero balance — row removed
        await helpers.assertBalance(indexerQuery, ADDR2, 'DBL', '300'); // unchanged from post-first-reorg
        await helpers.assertBalance(indexerQuery, ADDR3, 'DBL', '700');
    });

    // -----------------------------------------------------------------------
    // 8. Reorg preserves actions from non-reorged blocks
    // -----------------------------------------------------------------------
    it('8. actions in blocks before reorg point are preserved', async function () {
        const seeder = new DecoderSeeder(decoderQuery);

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

    // -----------------------------------------------------------------------
    // 9. Reorg with empty replacement blocks
    // -----------------------------------------------------------------------
    it('9. reorg with empty replacement blocks leaves only pre-reorg data', async function () {
        const seeder = new DecoderSeeder(decoderQuery);

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

    // -----------------------------------------------------------------------
    // 10. Action indexes are monotonically increasing after reorg + reindex
    // -----------------------------------------------------------------------
    it('10. action_indexes are monotonically increasing after reorg', async function () {
        const seeder = new DecoderSeeder(decoderQuery);

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
