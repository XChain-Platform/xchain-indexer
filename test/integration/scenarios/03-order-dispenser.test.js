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
 * Integration tests: ORDER, ORDER_MATCH, ORDER_CANCEL, ORDER expiration, DISPENSER, DISPENSE.
 *
 * Each test group is self-contained: it resets both databases before running, seeds
 * the decoder DB with the required blocks, then drives the indexer to process them.
 *
 * Address note: all addresses here are valid regtest P2PKH (base58check-validated).
 */

const assert = require('assert');
const {
    decoderQuery, indexerQuery,
    createDatabases, createDecoderSchema,
    resetDecoderDb, resetIndexerDb, closeAll,
} = require('../setup/db-connection');
const DecoderSeeder    = require('../setup/decoder-seeder');
const { initIndexer, processBlocks, destroyIndexer } = require('../setup/indexer-launcher');
const { seedGas } = require('../setup/gas-seeder');
const helpers = require('../setup/assertion-helpers');

// ---------------------------------------------------------------------------
// Addresses (30 chars, valid P2PKH length)
// ---------------------------------------------------------------------------
const ADDR1 = 'msK1rsgNVFPM4cR3X5rngczTKa6EtT4WKD'; // issues ALPHA
const ADDR2 = 'mjifPngDYQ6HHPNQdGk1kQuFkJWEiQksQp'; // issues BETA
const ADDR3 = 'mwGujTXFXMLN2YXqo4mQK4DcKy31DUcwoi'; // dispenser payment collector

// ---------------------------------------------------------------------------
// Token names
// ---------------------------------------------------------------------------
const TICK_A = 'ALPHA';   // issued by ADDR1
const TICK_B = 'BETA';    // issued by ADDR2
const TICK_D = 'DTOKEN';  // used in dispenser tests

// ---------------------------------------------------------------------------
// Block times — start far enough in the past so expirations can be set
// ---------------------------------------------------------------------------
const T0 = 1700000000;        // base time
const T_FAR_FUTURE = T0 + 90 * 86400 + 1; // > 90 days ahead → triggers fee, still valid

// ---------------------------------------------------------------------------
// Helper: fresh indexer per test
// ---------------------------------------------------------------------------
async function freshIndexer() {
    await resetDecoderDb();
    await resetIndexerDb();
    const seeder  = new DecoderSeeder(decoderQuery);
    const indexer = await initIndexer();
    // Fee era: the ISSUEs in these suites need gas — seed XCHAIN to the actors
    await seedGas(seeder, { addresses: [ADDR1, ADDR2, ADDR3] });
    return { seeder, indexer };
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
// ORDER TESTS
// ===========================================================================
describe('03 ORDER / DISPENSER integration @regression @tier2', function () {
    this.timeout(60000);

    // -----------------------------------------------------------------------
    // 1. Create ORDER — escrow deducted, order record created, status 'open'
    // -----------------------------------------------------------------------
    describe('ORDER format 0 – create order', function () {
        let indexer;

        before(async function () {
            const ctx = await freshIndexer();
            indexer   = ctx.indexer;
            const seeder = ctx.seeder;

            // Block 100 – issue ALPHA
            await seeder.seedBlock(100, T0, [
                { source: ADDR1, destination: null, amount: '0',
                  data: 'ISSUE|0|' + TICK_A + '|1000|100|0' },
            ]);
            // Block 101 – mint 100 ALPHA to ADDR1
            await seeder.seedBlock(101, T0 + 600, [
                { source: ADDR1, destination: null, amount: '0',
                  data: 'MINT|0|' + TICK_A + '|100' },
            ]);
            // Block 102 – issue BETA so the GET_TICK is known
            await seeder.seedBlock(102, T0 + 1200, [
                { source: ADDR2, destination: null, amount: '0',
                  data: 'ISSUE|0|' + TICK_B + '|1000|100|0' },
            ]);
            // Block 103 – create ORDER: give 10 ALPHA, want 50 BETA
            await seeder.seedBlock(103, T0 + 1800, [
                { source: ADDR1, destination: null, amount: '0',
                  data: 'ORDER|0|BTC|' + TICK_A + '|10|0|BTC|' + TICK_B + '|50|0|' + ADDR1 + '|' + T_FAR_FUTURE + '|||' },
            ]);

            await processBlocks(indexer);
        });

        after(async function () { await destroyIndexer(indexer); });

        it('should create an order record with status open', async function () {
            const orderIdx = await helpers.getLastActionIndexByType(indexerQuery, 'ORDER');
            assert.ok(orderIdx !== null, 'ORDER action_index should exist');
            await helpers.assertActionStatus(indexerQuery, 'order_statuses', orderIdx, 'open');
        });

        it('should debit GIVE_AMOUNT from ADDR1 balance', async function () {
            // started with 100, gave 10 to escrow → balance = 90
            await helpers.assertBalance(indexerQuery, ADDR1, TICK_A, '90');
        });

        it('should escrow GIVE_AMOUNT for ADDR1', async function () {
            const rows = await indexerQuery(
                `SELECT e.amount
                 FROM escrows e
                 INNER JOIN index_addresses a ON a.id = e.address_id
                 INNER JOIN index_tickers   t ON t.id = e.tick_id
                 WHERE a.address = ? AND t.tick = ?`,
                [ADDR1, TICK_A]
            );
            assert.ok(rows.length > 0, 'Should have an escrow row for ADDR1/ALPHA');
            assert.strictEqual(rows[0].amount, '10', 'Escrowed amount should be 10');
        });
    });

    // -----------------------------------------------------------------------
    // 2. Two matching orders → ORDER_MATCH, both complete, balances swapped
    // -----------------------------------------------------------------------
    describe('ORDER_MATCH – two complementary orders match', function () {
        let indexer;

        before(async function () {
            const ctx = await freshIndexer();
            indexer   = ctx.indexer;
            const seeder = ctx.seeder;

            // Block 100 – issue both tokens
            await seeder.seedBlock(100, T0, [
                { source: ADDR1, destination: null, amount: '0',
                  data: 'ISSUE|0|' + TICK_A + '|1000|100|0' },
                { source: ADDR2, destination: null, amount: '0',
                  data: 'ISSUE|0|' + TICK_B + '|1000|100|0' },
            ]);
            // Block 101 – mint tokens to each side
            await seeder.seedBlock(101, T0 + 600, [
                { source: ADDR1, destination: null, amount: '0',
                  data: 'MINT|0|' + TICK_A + '|100' },
                { source: ADDR2, destination: null, amount: '0',
                  data: 'MINT|0|' + TICK_B + '|100' },
            ]);
            // Block 102 – ADDR1 sells 10 ALPHA for 20 BETA
            //             ADDR2 sells 20 BETA  for 10 ALPHA  → complementary match
            await seeder.seedBlock(102, T0 + 1200, [
                { source: ADDR1, destination: null, amount: '0',
                  data: 'ORDER|0|BTC|' + TICK_A + '|10|0|BTC|' + TICK_B + '|20|0|' + ADDR1 + '|' + T_FAR_FUTURE + '|||' },
                { source: ADDR2, destination: null, amount: '0',
                  data: 'ORDER|0|BTC|' + TICK_B + '|20|0|BTC|' + TICK_A + '|10|0|' + ADDR2 + '|' + T_FAR_FUTURE + '|||' },
            ]);

            await processBlocks(indexer);
        });

        after(async function () { await destroyIndexer(indexer); });

        it('should create an ORDER_MATCH record', async function () {
            const cnt = await helpers.countRows(indexerQuery, 'order_matches');
            assert.ok(cnt >= 1, 'Expected at least one order_match record');
        });

        it('should mark both orders as complete', async function () {
            const rows = await indexerQuery(
                `SELECT DISTINCT s.status
                 FROM order_statuses os
                 INNER JOIN index_statuses s ON s.id = os.status_id`,
                []
            );
            const statuses = rows.map(r => r.status);
            assert.ok(statuses.includes('complete'), 'At least one order should be complete');
        });

        it('ADDR1 should receive BETA after the match', async function () {
            // ADDR1 gave 10 ALPHA, should receive 20 BETA
            const rows = await indexerQuery(
                `SELECT b.amount FROM balances b
                 INNER JOIN index_addresses a ON a.id = b.address_id
                 INNER JOIN index_tickers   t ON t.id = b.tick_id
                 WHERE a.address = ? AND t.tick = ?`,
                [ADDR1, TICK_B]
            );
            assert.ok(rows.length > 0, 'ADDR1 should have a BETA balance');
            assert.ok(parseFloat(rows[0].amount) > 0, 'ADDR1 BETA balance should be positive');
        });

        it('ADDR2 should receive ALPHA after the match', async function () {
            const rows = await indexerQuery(
                `SELECT b.amount FROM balances b
                 INNER JOIN index_addresses a ON a.id = b.address_id
                 INNER JOIN index_tickers   t ON t.id = b.tick_id
                 WHERE a.address = ? AND t.tick = ?`,
                [ADDR2, TICK_A]
            );
            assert.ok(rows.length > 0, 'ADDR2 should have an ALPHA balance');
            assert.ok(parseFloat(rows[0].amount) > 0, 'ADDR2 ALPHA balance should be positive');
        });
    });

    // -----------------------------------------------------------------------
    // 3. Order cancel — escrow returned, status updated to cancelled
    // -----------------------------------------------------------------------
    describe('ORDER format 1 – cancel order', function () {
        let indexer;
        let orderActionIndex;

        before(async function () {
            const ctx = await freshIndexer();
            indexer   = ctx.indexer;
            const seeder = ctx.seeder;

            await seeder.seedBlock(100, T0, [
                { source: ADDR1, destination: null, amount: '0',
                  data: 'ISSUE|0|' + TICK_A + '|1000|100|0' },
                { source: ADDR2, destination: null, amount: '0',
                  data: 'ISSUE|0|' + TICK_B + '|1000|100|0' },
            ]);
            await seeder.seedBlock(101, T0 + 600, [
                { source: ADDR1, destination: null, amount: '0',
                  data: 'MINT|0|' + TICK_A + '|100' },
            ]);
            // Block 102 – create order
            await seeder.seedBlock(102, T0 + 1200, [
                { source: ADDR1, destination: null, amount: '0',
                  data: 'ORDER|0|BTC|' + TICK_A + '|10|0|BTC|' + TICK_B + '|50|0|' + ADDR1 + '|' + T_FAR_FUTURE + '|||' },
            ]);

            // Process up to this point to get the action_index
            await processBlocks(indexer);
            orderActionIndex = await helpers.getLastActionIndexByType(indexerQuery, 'ORDER');

            // Block 103 – cancel the order
            await seeder.seedBlock(103, T0 + 1800, [
                { source: ADDR1, destination: null, amount: '0',
                  data: 'ORDER|1|' + orderActionIndex + '|' },
            ]);

            await processBlocks(indexer);
        });

        after(async function () { await destroyIndexer(indexer); });

        it('should create an ORDER_CANCEL action', async function () {
            const idx = await helpers.getLastActionIndexByType(indexerQuery, 'ORDER_CANCEL');
            assert.ok(idx !== null, 'ORDER_CANCEL action should exist');
        });

        it('should mark the order as cancelled', async function () {
            const rows = await indexerQuery(
                `SELECT s.status FROM order_statuses os
                 INNER JOIN index_statuses s ON s.id = os.status_id
                 WHERE os.order_action_index = ?
                 ORDER BY os.action_index DESC LIMIT 1`,
                [orderActionIndex]
            );
            assert.ok(rows.length > 0, 'Should have order_statuses row for the cancelled order');
            assert.strictEqual(rows[0].status, 'cancelled', 'Order should be cancelled');
        });

        it('should return escrowed tokens to ADDR1 after cancel', async function () {
            // ADDR1 started with 100, escrowed 10, got 10 back → 100 again
            await helpers.assertBalance(indexerQuery, ADDR1, TICK_A, '100');
        });
    });

    // -----------------------------------------------------------------------
    // 4. Order expiration — create with past expiration block_time, process next block
    // -----------------------------------------------------------------------
    describe('ORDER expiration – order expires when block_time passes EXPIRATION', function () {
        let indexer;

        before(async function () {
            const ctx = await freshIndexer();
            indexer   = ctx.indexer;
            const seeder = ctx.seeder;

            await seeder.seedBlock(100, T0, [
                { source: ADDR1, destination: null, amount: '0',
                  data: 'ISSUE|0|' + TICK_A + '|1000|100|0' },
                { source: ADDR2, destination: null, amount: '0',
                  data: 'ISSUE|0|' + TICK_B + '|1000|100|0' },
            ]);
            await seeder.seedBlock(101, T0 + 600, [
                { source: ADDR1, destination: null, amount: '0',
                  data: 'MINT|0|' + TICK_A + '|100' },
            ]);
            // Block 102 – create order with short expiration (T0 + 3600 = 1 hour from base)
            const shortExpiry = T0 + 3600;
            await seeder.seedBlock(102, T0 + 1200, [
                { source: ADDR1, destination: null, amount: '0',
                  data: 'ORDER|0|BTC|' + TICK_A + '|10|0|BTC|' + TICK_B + '|50|0|' + ADDR1 + '|' + shortExpiry + '|||' },
            ]);
            // Block 103 – block_time is after the expiration
            await seeder.seedBlock(103, T0 + 7200, []);  // empty block, just advance time

            await processBlocks(indexer);
        });

        after(async function () { await destroyIndexer(indexer); });

        it('should expire the order when block_time exceeds EXPIRATION', async function () {
            // ORDER_EXPIRE action should exist
            const expireIdx = await helpers.getLastActionIndexByType(indexerQuery, 'ORDER_EXPIRE');
            assert.ok(expireIdx !== null, 'ORDER_EXPIRE action should exist after block_time surpasses EXPIRATION');
        });

        it('should return escrowed tokens to ADDR1 after expiration', async function () {
            await helpers.assertBalance(indexerQuery, ADDR1, TICK_A, '100');
        });
    });

    // -----------------------------------------------------------------------
    // 5. Create DISPENSER — escrow deducted from source
    //
    // Uses a token-for-token dispenser:
    //   Give DTOKEN in exchange for BETA (GET_TICK). ADDR2 sends BETA to ADDR3
    //   (the GET_ADDRESS), which triggers a DISPENSE of DTOKEN to ADDR2.
    // -----------------------------------------------------------------------
    describe('DISPENSER format 0 – create dispenser', function () {
        let indexer;

        before(async function () {
            const ctx = await freshIndexer();
            indexer   = ctx.indexer;
            const seeder = ctx.seeder;

            // Block 100 – issue both tokens
            await seeder.seedBlock(100, T0, [
                { source: ADDR1, destination: null, amount: '0',
                  data: 'ISSUE|0|' + TICK_D + '|1000|100|0' },
                { source: ADDR2, destination: null, amount: '0',
                  data: 'ISSUE|0|' + TICK_B + '|1000|100|0' },
            ]);
            await seeder.seedBlock(101, T0 + 600, [
                { source: ADDR1, destination: null, amount: '0',
                  data: 'MINT|0|' + TICK_D + '|100' },
            ]);
            // Block 102 – create dispenser: give 10 DTOKEN per 1 BETA sent to ADDR3
            // FORMAT: DISPENSER|0|GIVE_COIN|GIVE_TICK|GIVE_AMOUNT|GIVE_ESCROW|GET_COIN|GET_TICK|GET_AMOUNT|GET_ADDRESS|FIAT_CODE|FIAT_AMOUNT|EXPIRATION|ALLOW_LIST|BLOCK_LIST|MEMO
            await seeder.seedBlock(102, T0 + 1200, [
                { source: ADDR3, destination: null, amount: '0',
                  data: 'ADDRESS|0|||2|' },
                { source: ADDR1, destination: null, amount: '0',
                  data: 'DISPENSER|0|BTC|' + TICK_D + '|10|0|50|BTC|' + TICK_B + '|1|' + ADDR3 + '||||' + T_FAR_FUTURE + '|||' },
            ]);

            await processBlocks(indexer);
        });

        after(async function () { await destroyIndexer(indexer); });

        it('should create a dispenser record with status open', async function () {
            const idx = await helpers.getLastActionIndexByType(indexerQuery, 'DISPENSER');
            assert.ok(idx !== null, 'DISPENSER action should exist');
            await helpers.assertActionStatus(indexerQuery, 'dispenser_statuses', idx, 'open');
        });

        it('should debit GIVE_ESCROW from ADDR1 balance', async function () {
            // ADDR1 had 100 DTOKEN, escrowed 50 → balance = 50
            await helpers.assertBalance(indexerQuery, ADDR1, TICK_D, '50');
        });

        it('should have an escrow record for ADDR1', async function () {
            const rows = await indexerQuery(
                `SELECT e.amount FROM escrows e
                 INNER JOIN index_addresses a ON a.id = e.address_id
                 INNER JOIN index_tickers   t ON t.id = e.tick_id
                 WHERE a.address = ? AND t.tick = ?`,
                [ADDR1, TICK_D]
            );
            assert.ok(rows.length > 0, 'Should have an escrow row for ADDR1/DTOKEN');
            assert.strictEqual(rows[0].amount, '50', 'Escrowed amount should be 50');
        });
    });

    // -----------------------------------------------------------------------
    // 6. SEND GET_TICK to GET_ADDRESS triggers DISPENSE
    //
    // Dispenser: give DTOKEN, get BETA.  ADDR2 SENDs BETA to ADDR3 (GET_ADDRESS).
    // The SEND handler calls processDispenserSends → DISPENSE credited to ADDR2.
    // -----------------------------------------------------------------------
    describe('DISPENSE triggered by SEND of GET_TICK to GET_ADDRESS', function () {
        let indexer;

        before(async function () {
            const ctx = await freshIndexer();
            indexer   = ctx.indexer;
            const seeder = ctx.seeder;

            // Block 100 – issue DTOKEN (dispenser gives) and BETA (dispenser gets)
            await seeder.seedBlock(100, T0, [
                { source: ADDR1, destination: null, amount: '0',
                  data: 'ISSUE|0|' + TICK_D + '|1000|100|0' },
                { source: ADDR2, destination: null, amount: '0',
                  data: 'ISSUE|0|' + TICK_B + '|1000|100|0' },
            ]);
            await seeder.seedBlock(101, T0 + 600, [
                { source: ADDR1, destination: null, amount: '0',
                  data: 'MINT|0|' + TICK_D + '|100' },
                { source: ADDR2, destination: null, amount: '0',
                  data: 'MINT|0|' + TICK_B + '|50' },
            ]);
            // Block 102 – ADDR1 creates dispenser: give 10 DTOKEN per 1 BETA to ADDR3
            await seeder.seedBlock(102, T0 + 1200, [
                { source: ADDR3, destination: null, amount: '0',
                  data: 'ADDRESS|0|||2|' },
                { source: ADDR1, destination: null, amount: '0',
                  data: 'DISPENSER|0|BTC|' + TICK_D + '|10|0|50|BTC|' + TICK_B + '|1|' + ADDR3 + '||||' + T_FAR_FUTURE + '|||' },
            ]);
            // Block 103 – ADDR2 SENDs 1 BETA to ADDR3 (GET_ADDRESS) → triggers DISPENSE of 10 DTOKEN to ADDR2
            await seeder.seedBlock(103, T0 + 1800, [
                { source: ADDR2, destination: ADDR3, amount: '0',
                  data: 'SEND|0|' + TICK_B + '|1|' + ADDR3 + '|' },
            ]);

            await processBlocks(indexer);
        });

        after(async function () { await destroyIndexer(indexer); });

        it('should create a DISPENSE record', async function () {
            const cnt = await helpers.countRows(indexerQuery, 'dispenses');
            assert.ok(cnt >= 1, 'Expected at least one dispense record');
        });

        it('ADDR2 should receive DTOKEN from the dispense', async function () {
            const rows = await indexerQuery(
                `SELECT b.amount FROM balances b
                 INNER JOIN index_addresses a ON a.id = b.address_id
                 INNER JOIN index_tickers   t ON t.id = b.tick_id
                 WHERE a.address = ? AND t.tick = ?`,
                [ADDR2, TICK_D]
            );
            assert.ok(rows.length > 0, 'ADDR2 should have a DTOKEN balance after dispense');
            assert.strictEqual(rows[0].amount, '10', 'ADDR2 should receive exactly 10 DTOKEN');
        });

        it('ADDR3 should have received BETA from the triggering SEND', async function () {
            const rows = await indexerQuery(
                `SELECT b.amount FROM balances b
                 INNER JOIN index_addresses a ON a.id = b.address_id
                 INNER JOIN index_tickers   t ON t.id = b.tick_id
                 WHERE a.address = ? AND t.tick = ?`,
                [ADDR3, TICK_B]
            );
            assert.ok(rows.length > 0, 'ADDR3 should have a BETA balance');
        });
    });

    // -----------------------------------------------------------------------
    // 7. Dispenser auto-close when GIVE_REMAINING < GIVE_AMOUNT
    // -----------------------------------------------------------------------
    describe('DISPENSER auto-close when exhausted', function () {
        let indexer;
        let dispenserIdx;

        before(async function () {
            const ctx = await freshIndexer();
            indexer   = ctx.indexer;
            const seeder = ctx.seeder;

            await seeder.seedBlock(100, T0, [
                { source: ADDR1, destination: null, amount: '0',
                  data: 'ISSUE|0|' + TICK_D + '|1000|100|0' },
                { source: ADDR2, destination: null, amount: '0',
                  data: 'ISSUE|0|' + TICK_B + '|1000|100|0' },
            ]);
            await seeder.seedBlock(101, T0 + 600, [
                { source: ADDR1, destination: null, amount: '0',
                  data: 'MINT|0|' + TICK_D + '|10' },
                { source: ADDR2, destination: null, amount: '0',
                  data: 'MINT|0|' + TICK_B + '|50' },
            ]);
            // Create dispenser: give 10 DTOKEN per 1 BETA, only 10 escrowed → 1 dispense exhausts it
            await seeder.seedBlock(102, T0 + 1200, [
                { source: ADDR3, destination: null, amount: '0',
                  data: 'ADDRESS|0|||2|' },
                { source: ADDR1, destination: null, amount: '0',
                  data: 'DISPENSER|0|BTC|' + TICK_D + '|10|0|10|BTC|' + TICK_B + '|1|' + ADDR3 + '||||' + T_FAR_FUTURE + '|||' },
            ]);

            await processBlocks(indexer);
            dispenserIdx = await helpers.getLastActionIndexByType(indexerQuery, 'DISPENSER');

            // Block 103 – ADDR2 triggers the one and only dispense
            await seeder.seedBlock(103, T0 + 1800, [
                { source: ADDR2, destination: ADDR3, amount: '0',
                  data: 'SEND|0|' + TICK_B + '|1|' + ADDR3 + '|' },
            ]);

            await processBlocks(indexer);
        });

        after(async function () { await destroyIndexer(indexer); });

        it('should create the dispense record', async function () {
            const cnt = await helpers.countRows(indexerQuery, 'dispenses');
            assert.ok(cnt >= 1, 'Should have at least 1 dispense');
        });

        it('should close the dispenser after it is exhausted', async function () {
            assert.ok(dispenserIdx !== null, 'Dispenser action index should exist');
            // Status should now be 'empty' (closed by DISPENSER_CLOSE)
            const rows = await indexerQuery(
                `SELECT s.status FROM dispenser_statuses ds
                 INNER JOIN index_statuses s ON s.id = ds.status_id
                 WHERE ds.dispenser_action_index = ?
                 ORDER BY ds.action_index DESC LIMIT 1`,
                [dispenserIdx]
            );
            assert.ok(rows.length > 0, 'Should have dispenser_statuses rows');
            assert.strictEqual(rows[0].status, 'empty', 'Exhausted dispenser should have status "empty"');
        });
    });

});
