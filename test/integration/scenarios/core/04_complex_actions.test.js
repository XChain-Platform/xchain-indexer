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
 * Integration tests: BATCH, SLEEP, SWEEP, DESTROY, LIST, AIRDROP.
 *
 * Each describe block resets both databases, seeds the decoder DB, then processes
 * blocks with a real XChainIndexer instance.
 *
 * Addresses are 30 chars (valid P2PKH length).
 *
 * SWEEP and DESTROY live in 04_complex_actions.test/sweep_destroy.test.js; LIST, AIRDROP
 * and the multi-block pipeline in 04_complex_actions.test/list_airdrop.test.js, all under
 * this file's describe title. The shared actors and chain helpers are in
 * 04_complex_actions.test/helpers/complex_chain.js.
 */

const assert = require('assert');
const { indexerQuery, createDatabases, createDecoderSchema, closeAll } = require('../../setup/db-connection');
const { processBlocks, destroyIndexer, destroyFileIndexers } = require('../../setup/indexer-launcher');
const helpers = require('../../setup/assertion-helpers');
const { ADDR1, ADDR2, ADDR3, TICK_X, T0, freshIndexer, seedGasToken } = require('./04_complex_actions.test/helpers/complex_chain');

// ---------------------------------------------------------------------------
// Suite-level setup / teardown
// ---------------------------------------------------------------------------
before(async function () {
    this.timeout(120000); // the tier's --timeout; a slow runner's schema build outlasts 30s
    await createDatabases(__filename);
    await createDecoderSchema();
});

after(async function () {
    await destroyFileIndexers(__filename);
    await closeAll();
});

// ===========================================================================
// BATCH TESTS
// ===========================================================================
// The chain the "BATCH – two SENDs in one transaction" tests read: seeded and processed once, exactly as that
// block's own before hook did before the body moved here.
async function seedBATCHTwoSENDsInOne() {
    const { seeder, indexer } = await freshIndexer();

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

    return indexer;
}

// The chain the "BATCH – ISSUE + MINT in one transaction" tests read: seeded and processed once, exactly as that
// block's own before hook did before the body moved here.
async function seedBATCHISSUEMINTInOne() {
    const { seeder, indexer } = await freshIndexer();

    // Fee era: the ISSUE below needs gas (file convention: seedGasToken)
    await seedGasToken(seeder, ADDR1, '100');

    // Block 100 – BATCH: issue XTOKEN + mint 50 XTOKEN in the same tx
    await seeder.seedBlock(100, T0, [
        { source: ADDR1, destination: null, amount: '0',
          data: 'BATCH|0|ISSUE|0|' + TICK_X + '|1000|100|0;MINT|0|' + TICK_X + '|50' },
    ]);

    await processBlocks(indexer);

    return indexer;
}

// The chain the "SLEEP format 0 – sleeping address cannot send" tests read: seeded and processed once, exactly as that
// block's own before hook did before the body moved here.
async function seedSLEEPFormat0SleepingAddress() {
    const { seeder, indexer } = await freshIndexer();

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
    // Block 103 – ADDR1 attempts a SEND (should fail: source sleeping)
    await seeder.seedBlock(103, T0 + 1800, [
        { source: ADDR1, destination: null, amount: '0',
          data: 'SEND|0|' + TICK_X + '|10|' + ADDR2 + '|' },
    ]);

    await processBlocks(indexer);

    return indexer;
}

// The chain the "SLEEP format 0 – indefinite sleep (RESUME_BLOCK = -1)" tests read: seeded and processed once, exactly as that
// block's own before hook did before the body moved here.
async function seedSLEEPFormat0IndefiniteSleep() {
    const { seeder, indexer } = await freshIndexer();

    // Fee era: the ISSUE below needs gas (file convention: seedGasToken)
    await seedGasToken(seeder, ADDR1, '100');

    await seeder.seedBlock(100, T0, [
        { source: ADDR1, destination: null, amount: '0',
          data: 'SLEEP|0|-1|indefinite sleep' },
    ]);

    await processBlocks(indexer);

    return indexer;
}

describe('04 complex actions – BATCH, SLEEP, SWEEP, DESTROY, LIST, AIRDROP @regression @tier2', function () {
    this.timeout(60000);

    // -----------------------------------------------------------------------
    // 1. BATCH with two SENDs: both processed, balances updated
    // -----------------------------------------------------------------------
    describe('BATCH – two SENDs in one transaction', function () {
        let indexer;

        before(async function () { indexer = await seedBATCHTwoSENDsInOne(); });

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
    // 2. BATCH with ISSUE + MINT: both valid
    // -----------------------------------------------------------------------
    describe('BATCH – ISSUE + MINT in one transaction', function () {
        let indexer;

        before(async function () { indexer = await seedBATCHISSUEMINTInOne(); });

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

});

describe('04 complex actions – BATCH, SLEEP, SWEEP, DESTROY, LIST, AIRDROP @regression @tier2', function () {
    this.timeout(60000);

    // -----------------------------------------------------------------------
    // 3. SLEEP address then SEND fails: SEND invalid because source is sleeping
    // -----------------------------------------------------------------------
    describe('SLEEP format 0 – sleeping address cannot send', function () {
        let indexer;

        before(async function () { indexer = await seedSLEEPFormat0SleepingAddress(); });

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

});

describe('04 complex actions – BATCH, SLEEP, SWEEP, DESTROY, LIST, AIRDROP @regression @tier2', function () {
    this.timeout(60000);

    // -----------------------------------------------------------------------
    // 4. SLEEP with RESUME_BLOCK = -1 (indefinite sleep)
    // -----------------------------------------------------------------------
    describe('SLEEP format 0 – indefinite sleep (RESUME_BLOCK = -1)', function () {
        let indexer;

        before(async function () { indexer = await seedSLEEPFormat0IndefiniteSleep(); });

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

});
