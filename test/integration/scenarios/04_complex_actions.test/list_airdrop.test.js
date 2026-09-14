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
 * test/integration/scenarios/04_complex_actions.test/list_airdrop.test.js
 *
 * The LIST and AIRDROP cases of the complex-actions suite, and the multi-block
 * ISSUE → MINT → LIST → AIRDROP pipeline that chains them.
 *
 * Kept under the entry file's describe title, so every full test title reads as it did
 * when the suite was one file (04_complex_actions.test.js holds the BATCH and SLEEP cases).
 * The actors and chain helpers are in helpers/complex_chain.js. Needs a disposable MariaDB,
 * like every scenario here.
 */

'use strict';

const assert = require('assert');
const { indexerQuery } = require('../../setup/db-connection');
const { processBlocks, destroyIndexer } = require('../../setup/indexer-launcher');
const helpers = require('../../setup/assertion-helpers');
const { ADDR1, ADDR2, ADDR3, ADDR4, TICK_X, TICK_Y, T0, freshIndexer, seedGasToken,
        fileSchemaHooks } = require('./helpers/complex_chain');

// This file's own scoped schemas, claimed in each block's before/after. The entry file
// claims its schemas in root hooks instead; a root hook here would run before every file of
// a whole-directory run rather than before these blocks.
const { createFileSchemas, closeFileSchemas } = fileSchemaHooks(__filename);

// The chain the "LIST format 0 – create address list" tests read: seeded and processed once, exactly as that
// block's own before hook did before the body moved here.
async function seedLISTFormat0CreateAddress() {
    const { seeder, indexer } = await freshIndexer();

    // Block 100 – create an address list with ADDR2 and ADDR3
    // FORMAT: LIST|0|TYPE|MEMO|ITEM1|ITEM2|...
    await seeder.seedBlock(100, T0, [
        { source: ADDR1, destination: null, amount: '0',
          data: 'LIST|0|2||' + ADDR2 + '|' + ADDR3 },
    ]);

    await processBlocks(indexer);

    return indexer;
}

// The chain the "AIRDROP format 0 – airdrop to address list" tests read: seeded and processed once, exactly as that
// block's own before hook did before the body moved here.
async function seedAIRDROPFormat0AirdropTo() {
    const { seeder, indexer } = await freshIndexer();

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
          data: 'LIST|0|2||' + ADDR2 + '|' + ADDR3 },
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

    return indexer;
}

// The chain the "Multi-block: full ISSUE → MINT → LIST → AIRDROP pipeline" tests read: seeded and processed once, exactly as that
// block's own before hook did before the body moved here.
async function seedMultiBlockFullISSUEMINT() {
    const { seeder, indexer } = await freshIndexer();

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
          data: 'LIST|0|2||' + ADDR2 + '|' + ADDR3 + '|' + ADDR4 },
    ]);

    // Process up to block 102 to get the LIST action_index
    await processBlocks(indexer);
    const listIdx = await helpers.getLastActionIndexByType(indexerQuery, 'LIST');

    // Block 103 – airdrop 10 YTOKEN per address (3 addresses = 30 total)
    await seeder.seedBlock(103, T0 + 1800, [
        { source: ADDR1, destination: null, amount: '0',
          data: 'AIRDROP|0|' + TICK_Y + '|10|' + listIdx + '|multi-block test' },
    ]);

    await processBlocks(indexer);

    return { indexer, listIdx };
}

describe('04 complex actions – BATCH, SLEEP, SWEEP, DESTROY, LIST, AIRDROP @regression @tier2', function () {
    this.timeout(60000);
    before(createFileSchemas);
    after(closeFileSchemas);

    // -----------------------------------------------------------------------
    // 7. LIST creation (type 2 = address list)
    // -----------------------------------------------------------------------
    describe('LIST format 0 – create address list', function () {
        let indexer;

        before(async function () { indexer = await seedLISTFormat0CreateAddress(); });

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

});

describe('04 complex actions – BATCH, SLEEP, SWEEP, DESTROY, LIST, AIRDROP @regression @tier2', function () {
    this.timeout(60000);
    before(createFileSchemas);
    after(closeFileSchemas);

    // -----------------------------------------------------------------------
    // 8. AIRDROP to address list members
    // -----------------------------------------------------------------------
    describe('AIRDROP format 0 – airdrop to address list', function () {
        let indexer;

        before(async function () { indexer = await seedAIRDROPFormat0AirdropTo(); });

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

});

describe('04 complex actions – BATCH, SLEEP, SWEEP, DESTROY, LIST, AIRDROP @regression @tier2', function () {
    this.timeout(60000);
    before(createFileSchemas);
    after(closeFileSchemas);

    // -----------------------------------------------------------------------
    // 9. Multi-block: ISSUE → MINT → LIST → AIRDROP → verify all balances
    // -----------------------------------------------------------------------
    describe('Multi-block: full ISSUE → MINT → LIST → AIRDROP pipeline', function () {
        let indexer;
        let listIdx;

        before(async function () { ({ indexer, listIdx } = await seedMultiBlockFullISSUEMINT()); });

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

    });
});

describe('04 complex actions – BATCH, SLEEP, SWEEP, DESTROY, LIST, AIRDROP @regression @tier2', function () {
    this.timeout(60000);
    before(createFileSchemas);
    after(closeFileSchemas);

    // The same pipeline, seeded again so these two tests run under the same hooks as
    // the block above rather than reading whatever that block left behind.
    describe('Multi-block: full ISSUE → MINT → LIST → AIRDROP pipeline', function () {
        let indexer;

        before(async function () { ({ indexer } = await seedMultiBlockFullISSUEMINT()); });

        after(async function () { await destroyIndexer(indexer); });

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
