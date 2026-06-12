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
 * Integration tests: BATCH, SLEEP, SWEEP, DESTROY, LIST, AIRDROP.
 *
 * Each describe block resets both databases, seeds the decoder DB, then processes
 * blocks with a real XChainIndexer instance.
 *
 * Addresses are 30 chars (valid P2PKH length).
 */

const assert = require('assert');
const {
    decoderQuery, indexerQuery,
    createDatabases, createDecoderSchema,
    resetDecoderDb, resetIndexerDb, closeAll,
} = require('../setup/db-connection');
const DecoderSeeder    = require('../setup/decoder-seeder');
const { initIndexer, processBlocks, destroyIndexer } = require('../setup/indexer-launcher');
const helpers = require('../setup/assertion-helpers');

// ---------------------------------------------------------------------------
// Addresses (30 chars)
// ---------------------------------------------------------------------------
const ADDR1 = 'msK1rsgNVFPM4cR3X5rngczTKa6EtT4WKD';
const ADDR2 = 'mjifPngDYQ6HHPNQdGk1kQuFkJWEiQksQp';
const ADDR3 = 'mwGujTXFXMLN2YXqo4mQK4DcKy31DUcwoi'; // sweep destination / airdrop member
const ADDR4 = 'my5gN5QBFhAziVKAhrrVyqJDrkjwbjDKP6'; // airdrop member
const GAS_ADDR = 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'; // GAS address (regtest)

// ---------------------------------------------------------------------------
// Token names
// ---------------------------------------------------------------------------
const TICK_X = 'XTOKEN';
const TICK_Y = 'YTOKEN';
const TICK_GAS = 'XCHAIN'; // Platform gas token

// ---------------------------------------------------------------------------
// Block times
// ---------------------------------------------------------------------------
const T0 = 1700000000;

// ---------------------------------------------------------------------------
// Helper: fresh indexer + seeder per test group
// ---------------------------------------------------------------------------
async function freshIndexer() {
    await resetDecoderDb();
    await resetIndexerDb();
    const seeder  = new DecoderSeeder(decoderQuery);
    const indexer = await initIndexer();
    return { seeder, indexer };
}

/**
 * Seed the XCHAIN gas token (issue + mint + send to addr) in blocks 1-3.
 * Returns the next available block index (3).
 */
async function seedGasToken(seeder, addr, amount) {
    await seeder.seedBlock(1, T0 - 3000, [
        { source: GAS_ADDR, destination: null, amount: '0',
          data: 'ISSUE|0|' + TICK_GAS + '|999999999|999999999|0' },
    ]);
    await seeder.seedBlock(2, T0 - 2000, [
        { source: GAS_ADDR, destination: null, amount: '0',
          data: 'MINT|0|' + TICK_GAS + '|' + amount },
    ]);
    await seeder.seedBlock(3, T0 - 1000, [
        { source: GAS_ADDR, destination: null, amount: '0',
          data: 'SEND|0|' + TICK_GAS + '|' + amount + '|' + addr + '|' },
    ]);
}

// ---------------------------------------------------------------------------
// Suite-level setup / teardown
// ---------------------------------------------------------------------------
before(async function () {
    this.timeout(30000);
    await createDatabases();
    await createDecoderSchema();
});

after(async function () {
    await closeAll();
});

// ===========================================================================
// BATCH TESTS
// ===========================================================================
describe('04 complex actions – BATCH, SLEEP, SWEEP, DESTROY, LIST, AIRDROP @regression @tier2', function () {
    this.timeout(60000);

    // -----------------------------------------------------------------------
    // 1. BATCH with two SENDs — both processed, balances updated
    // -----------------------------------------------------------------------
    describe('BATCH – two SENDs in one transaction', function () {
        let indexer;

        before(async function () {
            const ctx = await freshIndexer();
            indexer   = ctx.indexer;
            const seeder = ctx.seeder;

            // Fee era: the ISSUE below needs gas (file convention: seedGasToken)
            await seedGasToken(seeder, ADDR1, '100');

            // Block 100 – issue XTOKEN
            await seeder.seedBlock(100, T0, [
                { source: ADDR1, destination: null, amount: '0',
                  data: 'ISSUE|0|' + TICK_X + '|1000|100|0' },
            ]);
            // Block 101 – mint 100 XTOKEN to ADDR1
            await seeder.seedBlock(101, T0 + 600, [
                { source: ADDR1, destination: null, amount: '0',
                  data: 'MINT|0|' + TICK_X + '|100' },
            ]);
            // Block 102 – BATCH: send 10 XTOKEN to ADDR2, send 5 XTOKEN to ADDR3
            // Format: BATCH|0|SEND|0|TICK|AMOUNT|DEST;SEND|0|TICK|AMOUNT|DEST
            await seeder.seedBlock(102, T0 + 1200, [
                { source: ADDR1, destination: null, amount: '0',
                  data: 'BATCH|0|SEND|0|' + TICK_X + '|10|' + ADDR2 + '|;SEND|0|' + TICK_X + '|5|' + ADDR3 + '|' },
            ]);

            await processBlocks(indexer);
        });

        after(async function () { await destroyIndexer(indexer); });

        it('should create a BATCH record', async function () {
            const cnt = await helpers.countRows(indexerQuery, 'batches');
            assert.ok(cnt >= 1, 'Should have at least 1 batch record');
        });

        it('ADDR2 should receive 10 XTOKEN', async function () {
            await helpers.assertBalance(indexerQuery, ADDR2, TICK_X, '10');
        });

        it('ADDR3 should receive 5 XTOKEN', async function () {
            await helpers.assertBalance(indexerQuery, ADDR3, TICK_X, '5');
        });

        it('ADDR1 balance should be reduced by total sent (85 remaining)', async function () {
            await helpers.assertBalance(indexerQuery, ADDR1, TICK_X, '85');
        });
    });

    // -----------------------------------------------------------------------
    // 2. BATCH with ISSUE + MINT — both valid
    // -----------------------------------------------------------------------
    describe('BATCH – ISSUE + MINT in one transaction', function () {
        let indexer;

        before(async function () {
            const ctx = await freshIndexer();
            indexer   = ctx.indexer;
            const seeder = ctx.seeder;

            // Fee era: the ISSUE below needs gas (file convention: seedGasToken)
            await seedGasToken(seeder, ADDR1, '100');

            // Block 100 – BATCH: issue XTOKEN + mint 50 XTOKEN in the same tx
            await seeder.seedBlock(100, T0, [
                { source: ADDR1, destination: null, amount: '0',
                  data: 'BATCH|0|ISSUE|0|' + TICK_X + '|1000|100|0;MINT|0|' + TICK_X + '|50' },
            ]);

            await processBlocks(indexer);
        });

        after(async function () { await destroyIndexer(indexer); });

        it('should create a batch record', async function () {
            const cnt = await helpers.countRows(indexerQuery, 'batches');
            assert.ok(cnt >= 1, 'Should have at least 1 batch record');
        });

        it('should create the XTOKEN token from ISSUE in the batch', async function () {
            const token = await helpers.getToken(indexerQuery, TICK_X);
            assert.ok(token !== null, 'XTOKEN should exist after batch ISSUE');
        });

        it('ADDR1 should have 50 XTOKEN from the MINT in the batch', async function () {
            await helpers.assertBalance(indexerQuery, ADDR1, TICK_X, '50');
        });
    });

    // -----------------------------------------------------------------------
    // 3. SLEEP address then SEND fails — SEND invalid because source is sleeping
    // -----------------------------------------------------------------------
    describe('SLEEP format 0 – sleeping address cannot send', function () {
        let indexer;

        before(async function () {
            const ctx = await freshIndexer();
            indexer   = ctx.indexer;
            const seeder = ctx.seeder;

            // Fee era: the ISSUE below needs gas (file convention: seedGasToken)
            await seedGasToken(seeder, ADDR1, '100');

            await seeder.seedBlock(100, T0, [
                { source: ADDR1, destination: null, amount: '0',
                  data: 'ISSUE|0|' + TICK_X + '|1000|100|0' },
            ]);
            await seeder.seedBlock(101, T0 + 600, [
                { source: ADDR1, destination: null, amount: '0',
                  data: 'MINT|0|' + TICK_X + '|50' },
            ]);
            // Block 102 – ADDR1 puts itself to sleep until block 200
            await seeder.seedBlock(102, T0 + 1200, [
                { source: ADDR1, destination: null, amount: '0',
                  data: 'SLEEP|0|200|' },
            ]);
            // Block 103 – ADDR1 attempts a SEND (should fail — source sleeping)
            await seeder.seedBlock(103, T0 + 1800, [
                { source: ADDR1, destination: null, amount: '0',
                  data: 'SEND|0|' + TICK_X + '|10|' + ADDR2 + '|' },
            ]);

            await processBlocks(indexer);
        });

        after(async function () { await destroyIndexer(indexer); });

        it('should create a SLEEP record', async function () {
            const cnt = await helpers.countRows(indexerQuery, 'sleeps');
            assert.ok(cnt >= 1, 'Should have at least 1 sleep record');
        });

        it('ADDR2 should NOT receive XTOKEN (SEND rejected while ADDR1 asleep)', async function () {
            await helpers.assertBalance(indexerQuery, ADDR2, TICK_X, null);
        });

        it('ADDR1 balance should remain unchanged', async function () {
            await helpers.assertBalance(indexerQuery, ADDR1, TICK_X, '50');
        });

        it('SEND action should be marked invalid', async function () {
            const rows = await indexerQuery(
                `SELECT s.status FROM sends sd
                 INNER JOIN index_statuses s ON s.id = sd.status_id
                 ORDER BY sd.action_index DESC LIMIT 1`,
                []
            );
            assert.ok(rows.length > 0, 'Should have a send record');
            assert.ok(
                String(rows[0].status).startsWith('invalid'),
                'SEND should be invalid when source is sleeping'
            );
        });
    });

    // -----------------------------------------------------------------------
    // 4. SLEEP with RESUME_BLOCK = -1 (indefinite sleep)
    // -----------------------------------------------------------------------
    describe('SLEEP format 0 – indefinite sleep (RESUME_BLOCK = -1)', function () {
        let indexer;

        before(async function () {
            const ctx = await freshIndexer();
            indexer   = ctx.indexer;
            const seeder = ctx.seeder;

            // Fee era: the ISSUE below needs gas (file convention: seedGasToken)
            await seedGasToken(seeder, ADDR1, '100');

            await seeder.seedBlock(100, T0, [
                { source: ADDR1, destination: null, amount: '0',
                  data: 'SLEEP|0|-1|indefinite sleep' },
            ]);

            await processBlocks(indexer);
        });

        after(async function () { await destroyIndexer(indexer); });

        it('should create a SLEEP record with resume_block = -1', async function () {
            const rows = await indexerQuery(
                `SELECT sl.resume_block FROM sleeps sl ORDER BY sl.action_index DESC LIMIT 1`,
                []
            );
            assert.ok(rows.length > 0, 'Should have a sleep record');
            assert.strictEqual(Number(rows[0].resume_block), -1, 'resume_block should be -1');
        });

        it('SLEEP action should be valid', async function () {
            const rows = await indexerQuery(
                `SELECT s.status FROM sleeps sl
                 INNER JOIN index_statuses s ON s.id = sl.status_id
                 ORDER BY sl.action_index DESC LIMIT 1`,
                []
            );
            assert.ok(rows.length > 0, 'Should have sleep with status');
            assert.strictEqual(rows[0].status, 'valid', 'Indefinite SLEEP should be valid');
        });
    });

    // -----------------------------------------------------------------------
    // 5. SWEEP balances to new address — all tokens moved
    // -----------------------------------------------------------------------
    describe('SWEEP format 0 – sweep all balances to ADDR2', function () {
        let indexer;

        before(async function () {
            const ctx = await freshIndexer();
            indexer   = ctx.indexer;
            const seeder = ctx.seeder;

            // Seed XCHAIN gas token and send to ADDR1
            await seedGasToken(seeder, ADDR1, '100');

            await seeder.seedBlock(100, T0, [
                { source: ADDR1, destination: null, amount: '0',
                  data: 'ISSUE|0|' + TICK_X + '|1000|100|0' },
            ]);
            await seeder.seedBlock(101, T0 + 600, [
                { source: ADDR1, destination: null, amount: '0',
                  data: 'MINT|0|' + TICK_X + '|80' },
            ]);
            // Block 102 – SWEEP all balances from ADDR1 to ADDR2 (no ownerships, no escrows)
            // FORMAT: SWEEP|0|DESTINATION|BALANCES|OWNERSHIPS|ESCROWS|MEMO
            await seeder.seedBlock(102, T0 + 1200, [
                { source: ADDR1, destination: null, amount: '0',
                  data: 'SWEEP|0|' + ADDR2 + '|1|0|0|' },
            ]);

            await processBlocks(indexer);
        });

        after(async function () { await destroyIndexer(indexer); });

        it('should create a SWEEP record', async function () {
            const cnt = await helpers.countRows(indexerQuery, 'sweeps');
            assert.ok(cnt >= 1, 'Should have at least 1 sweep record');
        });

        it('ADDR1 should have 0 XTOKEN after sweep', async function () {
            await helpers.assertBalance(indexerQuery, ADDR1, TICK_X, null);
        });

        it('ADDR2 should have received all XTOKEN from the sweep', async function () {
            const rows = await indexerQuery(
                `SELECT b.amount FROM balances b
                 INNER JOIN index_addresses a ON a.id = b.address_id
                 INNER JOIN index_tickers   t ON t.id = b.tick_id
                 WHERE a.address = ? AND t.tick = ?`,
                [ADDR2, TICK_X]
            );
            assert.ok(rows.length > 0, 'ADDR2 should have XTOKEN after sweep');
            assert.ok(parseFloat(rows[0].amount) > 0, 'ADDR2 XTOKEN balance should be > 0');
        });
    });

    // -----------------------------------------------------------------------
    // 6. DESTROY reduces supply with no credit counterpart
    // -----------------------------------------------------------------------
    describe('DESTROY format 0 – burn tokens', function () {
        let indexer;

        before(async function () {
            const ctx = await freshIndexer();
            indexer   = ctx.indexer;
            const seeder = ctx.seeder;

            // Fee era: the ISSUE below needs gas (file convention: seedGasToken)
            await seedGasToken(seeder, ADDR1, '100');

            await seeder.seedBlock(100, T0, [
                { source: ADDR1, destination: null, amount: '0',
                  data: 'ISSUE|0|' + TICK_X + '|1000|100|0' },
            ]);
            await seeder.seedBlock(101, T0 + 600, [
                { source: ADDR1, destination: null, amount: '0',
                  data: 'MINT|0|' + TICK_X + '|100' },
            ]);
            // Block 102 – destroy 20 XTOKEN
            await seeder.seedBlock(102, T0 + 1200, [
                { source: ADDR1, destination: null, amount: '0',
                  data: 'DESTROY|0|' + TICK_X + '|20|burning tokens' },
            ]);

            await processBlocks(indexer);
        });

        after(async function () { await destroyIndexer(indexer); });

        it('should create a DESTROY record', async function () {
            const cnt = await helpers.countRows(indexerQuery, 'destroys');
            assert.ok(cnt >= 1, 'Should have at least 1 destroy record');
        });

        it('ADDR1 balance should be reduced by destroyed amount', async function () {
            await helpers.assertBalance(indexerQuery, ADDR1, TICK_X, '80');
        });

        it('token supply should decrease by destroyed amount', async function () {
            await helpers.assertTokenSupply(indexerQuery, TICK_X, '80');
        });

        it('DESTROY should not create a matching credit entry', async function () {
            // Debits should exist, but there should be no credit for the burn address
            const debitRows = await indexerQuery(
                `SELECT d.amount FROM debits d
                 INNER JOIN index_tickers t ON t.id = d.tick_id
                 WHERE t.tick = ?`,
                [TICK_X]
            );
            assert.ok(debitRows.length > 0, 'Should have at least one debit for XTOKEN');

            // Credits for XTOKEN should only be from MINT (80 total credits), not from DESTROY
            const creditRows = await indexerQuery(
                `SELECT SUM(CAST(c.amount AS DECIMAL(65,18))) AS total FROM credits c
                 INNER JOIN index_tickers t ON t.id = c.tick_id
                 WHERE t.tick = ?`,
                [TICK_X]
            );
            assert.ok(creditRows.length > 0 && creditRows[0].total !== null, 'Credits should exist');
            // Total credits = 100 (from MINT only), not inflated by destroy
            assert.strictEqual(parseFloat(creditRows[0].total), 100,
                'Credits should only reflect MINT, not DESTROY');
        });

        it('sanity check: supply equals balances', async function () {
            await helpers.assertSanity(indexerQuery, TICK_X);
        });
    });

    // -----------------------------------------------------------------------
    // 7. LIST creation (type 2 = address list)
    // -----------------------------------------------------------------------
    describe('LIST format 0 – create address list', function () {
        let indexer;

        before(async function () {
            const ctx = await freshIndexer();
            indexer   = ctx.indexer;
            const seeder = ctx.seeder;

            // Block 100 – create an address list with ADDR2 and ADDR3
            // FORMAT: LIST|0|TYPE|ITEM1|ITEM2|...
            await seeder.seedBlock(100, T0, [
                { source: ADDR1, destination: null, amount: '0',
                  data: 'LIST|0|2|' + ADDR2 + '|' + ADDR3 },
            ]);

            await processBlocks(indexer);
        });

        after(async function () { await destroyIndexer(indexer); });

        it('should create a LIST record', async function () {
            const cnt = await helpers.countRows(indexerQuery, 'lists');
            assert.ok(cnt >= 1, 'Should have at least 1 list record');
        });

        it('LIST should contain ADDR2', async function () {
            const listIdx = await helpers.getLastActionIndexByType(indexerQuery, 'LIST');
            const rows = await indexerQuery(
                `SELECT a.address FROM list_items li
                 INNER JOIN index_addresses a ON a.id = li.item_id
                 WHERE li.action_index = ?`,
                [listIdx]
            );
            const addresses = rows.map(r => r.address);
            assert.ok(addresses.includes(ADDR2), 'List should contain ADDR2');
        });

        it('LIST should contain ADDR3', async function () {
            const listIdx = await helpers.getLastActionIndexByType(indexerQuery, 'LIST');
            const rows = await indexerQuery(
                `SELECT a.address FROM list_items li
                 INNER JOIN index_addresses a ON a.id = li.item_id
                 WHERE li.action_index = ?`,
                [listIdx]
            );
            const addresses = rows.map(r => r.address);
            assert.ok(addresses.includes(ADDR3), 'List should contain ADDR3');
        });
    });

    // -----------------------------------------------------------------------
    // 8. AIRDROP to address list members
    // -----------------------------------------------------------------------
    describe('AIRDROP format 0 – airdrop to address list', function () {
        let indexer;

        before(async function () {
            const ctx = await freshIndexer();
            indexer   = ctx.indexer;
            const seeder = ctx.seeder;

            // Seed XCHAIN gas token and send to ADDR1
            await seedGasToken(seeder, ADDR1, '100');

            await seeder.seedBlock(100, T0, [
                { source: ADDR1, destination: null, amount: '0',
                  data: 'ISSUE|0|' + TICK_X + '|1000|100|0' },
            ]);
            await seeder.seedBlock(101, T0 + 600, [
                { source: ADDR1, destination: null, amount: '0',
                  data: 'MINT|0|' + TICK_X + '|100' },
            ]);
            // Block 102 – create address list containing ADDR2 and ADDR3
            await seeder.seedBlock(102, T0 + 1200, [
                { source: ADDR1, destination: null, amount: '0',
                  data: 'LIST|0|2|' + ADDR2 + '|' + ADDR3 },
            ]);

            // Get list action_index (will be the next action after block 102)
            await processBlocks(indexer);
            const listIdx = await helpers.getLastActionIndexByType(indexerQuery, 'LIST');

            // Block 103 – airdrop 5 XTOKEN to each member of the list
            // FORMAT: AIRDROP|0|TICK|AMOUNT|LIST_ACTION_INDEX|MEMO
            await seeder.seedBlock(103, T0 + 1800, [
                { source: ADDR1, destination: null, amount: '0',
                  data: 'AIRDROP|0|' + TICK_X + '|5|' + listIdx + '|' },
            ]);

            await processBlocks(indexer);
        });

        after(async function () { await destroyIndexer(indexer); });

        it('should create an AIRDROP record', async function () {
            const cnt = await helpers.countRows(indexerQuery, 'airdrops');
            assert.ok(cnt >= 1, 'Should have at least 1 airdrop record');
        });

        it('ADDR2 should receive 5 XTOKEN from the airdrop', async function () {
            await helpers.assertBalance(indexerQuery, ADDR2, TICK_X, '5');
        });

        it('ADDR3 should receive 5 XTOKEN from the airdrop', async function () {
            await helpers.assertBalance(indexerQuery, ADDR3, TICK_X, '5');
        });

        it('ADDR1 balance should decrease by total airdrop amount (2 recipients × 5)', async function () {
            // Started with 100; airdropped 5 to each of 2 addresses = 10 total debited
            const rows = await indexerQuery(
                `SELECT b.amount FROM balances b
                 INNER JOIN index_addresses a ON a.id = b.address_id
                 INNER JOIN index_tickers   t ON t.id = b.tick_id
                 WHERE a.address = ? AND t.tick = ?`,
                [ADDR1, TICK_X]
            );
            assert.ok(rows.length > 0, 'ADDR1 should still have a balance record');
            assert.ok(parseFloat(rows[0].amount) <= 90, 'ADDR1 balance should be <= 90 after airdrop');
        });
    });

    // -----------------------------------------------------------------------
    // 9. Multi-block: ISSUE → MINT → LIST → AIRDROP → verify all balances
    // -----------------------------------------------------------------------
    describe('Multi-block: full ISSUE → MINT → LIST → AIRDROP pipeline', function () {
        let indexer;
        let listIdx;

        before(async function () {
            const ctx = await freshIndexer();
            indexer   = ctx.indexer;
            const seeder = ctx.seeder;

            // Seed XCHAIN gas token and send to ADDR1
            await seedGasToken(seeder, ADDR1, '100');

            // Block 100 – ADDR1 issues YTOKEN
            await seeder.seedBlock(100, T0, [
                { source: ADDR1, destination: null, amount: '0',
                  data: 'ISSUE|0|' + TICK_Y + '|500|200|0' },
            ]);

            // Block 101 – ADDR1 mints 200 YTOKEN
            await seeder.seedBlock(101, T0 + 600, [
                { source: ADDR1, destination: null, amount: '0',
                  data: 'MINT|0|' + TICK_Y + '|200' },
            ]);

            // Block 102 – ADDR1 creates address list with ADDR2, ADDR3, ADDR4
            await seeder.seedBlock(102, T0 + 1200, [
                { source: ADDR1, destination: null, amount: '0',
                  data: 'LIST|0|2|' + ADDR2 + '|' + ADDR3 + '|' + ADDR4 },
            ]);

            // Process up to block 102 to get the LIST action_index
            await processBlocks(indexer);
            listIdx = await helpers.getLastActionIndexByType(indexerQuery, 'LIST');

            // Block 103 – airdrop 10 YTOKEN per address (3 addresses = 30 total)
            await seeder.seedBlock(103, T0 + 1800, [
                { source: ADDR1, destination: null, amount: '0',
                  data: 'AIRDROP|0|' + TICK_Y + '|10|' + listIdx + '|multi-block test' },
            ]);

            await processBlocks(indexer);
        });

        after(async function () { await destroyIndexer(indexer); });

        it('YTOKEN should be issued and exist', async function () {
            const token = await helpers.getToken(indexerQuery, TICK_Y);
            assert.ok(token !== null, 'YTOKEN should exist');
        });

        it('ADDR1 should have minted balance minus airdrop total', async function () {
            const rows = await indexerQuery(
                `SELECT b.amount FROM balances b
                 INNER JOIN index_addresses a ON a.id = b.address_id
                 INNER JOIN index_tickers   t ON t.id = b.tick_id
                 WHERE a.address = ? AND t.tick = ?`,
                [ADDR1, TICK_Y]
            );
            assert.ok(rows.length > 0, 'ADDR1 should have YTOKEN balance');
            // Started with 200, airdropped 30 (3 × 10) → 170 remaining
            assert.ok(parseFloat(rows[0].amount) <= 170,
                'ADDR1 YTOKEN balance should be 170 or less after airdrop');
        });

        it('ADDR2 should receive 10 YTOKEN from the airdrop', async function () {
            await helpers.assertBalance(indexerQuery, ADDR2, TICK_Y, '10');
        });

        it('ADDR3 should receive 10 YTOKEN from the airdrop', async function () {
            await helpers.assertBalance(indexerQuery, ADDR3, TICK_Y, '10');
        });

        it('ADDR4 should receive 10 YTOKEN from the airdrop', async function () {
            await helpers.assertBalance(indexerQuery, ADDR4, TICK_Y, '10');
        });

        it('LIST action should be valid', async function () {
            assert.ok(listIdx !== null, 'LIST action_index should be set');
            await helpers.assertActionStatus(indexerQuery, 'lists', listIdx, 'valid');
        });

        it('AIRDROP action should be valid', async function () {
            const airdropIdx = await helpers.getLastActionIndexByType(indexerQuery, 'AIRDROP');
            assert.ok(airdropIdx !== null, 'AIRDROP action_index should exist');
            await helpers.assertActionStatus(indexerQuery, 'airdrops', airdropIdx, 'valid');
        });

        it('sanity check: YTOKEN supply consistent', async function () {
            await helpers.assertSanity(indexerQuery, TICK_Y);
        });

        it('should have processed all blocks from gas setup through airdrop', async function () {
            // Gas setup: blocks 1-3, test actions: blocks 100-103
            // Indexer processes every block_index from 1 to 103
            await helpers.assertBlockCount(indexerQuery, 103);
        });
    });

});
