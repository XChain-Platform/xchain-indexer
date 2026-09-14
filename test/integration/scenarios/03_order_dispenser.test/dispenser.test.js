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
 * test/integration/scenarios/03_order_dispenser.test/dispenser.test.js
 *
 * The DISPENSER cases of the order and dispenser suite: create, a DISPENSE triggered by a
 * SEND of GET_TICK to the GET_ADDRESS, and auto-close once the escrow is exhausted.
 *
 * Kept under the entry file's describe title, so every full test title reads as it did
 * when the suite was one file (03_order_dispenser.test.js holds the ORDER cases). The
 * actors, tokens and fresh-indexer helper are in helpers/order_book_chain.js. Needs a
 * disposable MariaDB, like every scenario here.
 */

'use strict';

const assert = require('assert');
const { indexerQuery } = require('../../setup/db-connection');
const { processBlocks, destroyIndexer } = require('../../setup/indexer-launcher');
const helpers = require('../../setup/assertion-helpers');
const { ADDR1, ADDR2, ADDR3, TICK_B, TICK_D, T0, T_FAR_FUTURE, freshIndexer, fileSchemaHooks } = require('./helpers/order_book_chain');

// This file's own scoped schemas, claimed in each block's before/after. The entry file
// claims its schemas in root hooks instead; a root hook here would run before every file of
// a whole-directory run rather than before these blocks.
const { createFileSchemas, closeFileSchemas } = fileSchemaHooks(__filename);

// The chain the "DISPENSER format 0 – create dispenser" tests read: seeded and processed once, exactly as that
// block's own before hook did before the body moved here.
async function seedDISPENSERFormat0CreateDispenser() {
    const { seeder, indexer } = await freshIndexer();

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

    return indexer;
}

// The chain the "DISPENSE triggered by SEND of GET_TICK to GET_ADDRESS" tests read: seeded and processed once, exactly as that
// block's own before hook did before the body moved here.
async function seedDISPENSETriggeredBySENDOf() {
    const { seeder, indexer } = await freshIndexer();

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

    return indexer;
}

// The chain the "DISPENSER auto-close when exhausted" tests read: seeded and processed once, exactly as that
// block's own before hook did before the body moved here.
async function seedDISPENSERAutoCloseWhenExhausted() {
    const { seeder, indexer } = await freshIndexer();

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
    const dispenserIdx = await helpers.getLastActionIndexByType(indexerQuery, 'DISPENSER');

    // Block 103 – ADDR2 triggers the one and only dispense
    await seeder.seedBlock(103, T0 + 1800, [
        { source: ADDR2, destination: ADDR3, amount: '0',
          data: 'SEND|0|' + TICK_B + '|1|' + ADDR3 + '|' },
    ]);

    await processBlocks(indexer);

    return { indexer, dispenserIdx };
}

describe('03 ORDER / DISPENSER integration @regression @tier2', function () {
    this.timeout(60000);
    before(createFileSchemas);
    after(closeFileSchemas);

    // -----------------------------------------------------------------------
    // 5. Create DISPENSER (escrow deducted from source)
    //
    // Uses a token-for-token dispenser:
    //   Give DTOKEN in exchange for BETA (GET_TICK). ADDR2 sends BETA to ADDR3
    //   (the GET_ADDRESS), which triggers a DISPENSE of DTOKEN to ADDR2.
    // -----------------------------------------------------------------------
    describe('DISPENSER format 0 – create dispenser', function () {
        let indexer;

        before(async function () { indexer = await seedDISPENSERFormat0CreateDispenser(); });

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

});

describe('03 ORDER / DISPENSER integration @regression @tier2', function () {
    this.timeout(60000);
    before(createFileSchemas);
    after(closeFileSchemas);

    // -----------------------------------------------------------------------
    // 6. SEND GET_TICK to GET_ADDRESS triggers DISPENSE
    //
    // Dispenser: give DTOKEN, get BETA.  ADDR2 SENDs BETA to ADDR3 (GET_ADDRESS).
    // The SEND handler calls processDispenserSends → DISPENSE credited to ADDR2.
    // -----------------------------------------------------------------------
    describe('DISPENSE triggered by SEND of GET_TICK to GET_ADDRESS', function () {
        let indexer;

        before(async function () { indexer = await seedDISPENSETriggeredBySENDOf(); });

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

});

describe('03 ORDER / DISPENSER integration @regression @tier2', function () {
    this.timeout(60000);
    before(createFileSchemas);
    after(closeFileSchemas);

    // -----------------------------------------------------------------------
    // 7. Dispenser auto-close when GIVE_REMAINING < GIVE_AMOUNT
    // -----------------------------------------------------------------------
    describe('DISPENSER auto-close when exhausted', function () {
        let indexer;
        let dispenserIdx;

        before(async function () { ({ indexer, dispenserIdx } = await seedDISPENSERAutoCloseWhenExhausted()); });

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
