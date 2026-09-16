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
 * E2E Test: Blockchain Reorganization
 *
 * Verifies that chain reorgs cause proper rollback: post-reorg state
 * is correctly reflected through the explorer API.
 */

'use strict';

const assert = require('assert');
const { decoderQuery, indexerQuery, createDatabases, createDecoderSchema,
        resetDecoderDb, resetIndexerDb, closeAll } = require('../../integration/setup/db-connection');
const DecoderSeeder = require('../../integration/setup/decoder-seeder');
const { initIndexer, processBlocks, destroyIndexer, destroyFileIndexers } = require('../../integration/setup/indexer-launcher');
const { startExplorer, stopExplorer, resetExplorerPools } = require('../setup/explorer-launcher');
const { createClient } = require('../setup/api-client');
const { assertApiOk, assertTokenFields, assertBalanceEntry,
        assertListResponse } = require('../setup/api-assertions');

const ADDR1 = 'mAddr1XXXXXXXXXXXXXXXXXXXXXXX1';
const ADDR2 = 'mAddr2XXXXXXXXXXXXXXXXXXXXXXX2';

const BASE_TIME = 1700000000;
const COIN = 'RBTC';

// --- Phase 1: Original chain ---
// Index the pre-reorg chain: a token issued in block 100, minted in 101 and partly sent in
// 102. Returns the seeder and the running indexer, because the caller asserts on the API
// while that indexer is still up, exactly as the single test body did.
async function indexOriginalChain(explorer) {
    await resetDecoderDb();
    await resetIndexerDb();
    await resetExplorerPools(explorer);

    const seeder = new DecoderSeeder(decoderQuery);
    const indexer = await initIndexer();

    // Block 100: Issue token
    await seeder.seedBlock(100, BASE_TIME, [
        { source: ADDR1, data: 'ISSUE|0|RTOK|10000|1000|0|Reorg test' }
    ]);
    // Block 101: Mint 200
    await seeder.seedBlock(101, BASE_TIME + 10, [
        { source: ADDR1, data: 'MINT|0|RTOK|200' }
    ]);
    // Block 102: Send 50 to ADDR2
    await seeder.seedBlock(102, BASE_TIME + 20, [
        { source: ADDR1, data: 'SEND|0|RTOK|50|' + ADDR2 }
    ]);

    await processBlocks(indexer);
    return { seeder, indexer };
}

// Verify pre-reorg state
async function assertPreReorgState(client) {
    let res = await client.get(`/${COIN}/api/token/RTOK`);
    assertApiOk(res, 'pre-reorg token');
    assert.strictEqual(res.body.supply.current, '200');

    res = await client.get(`/${COIN}/api/balances/${ADDR1}`);
    assertApiOk(res, 'pre-reorg balance ADDR1');
    assertBalanceEntry(res.body, 'RTOK', '150');

    res = await client.get(`/${COIN}/api/balances/${ADDR2}`);
    assertApiOk(res, 'pre-reorg balance ADDR2');
    assertBalanceEntry(res.body, 'RTOK', '50');
}

// --- Phase 2: Reorg at block 101 ---
// Delete blocks >= 101 from decoder and seed reorg event
// Then index the replacement chain with a fresh indexer, which is what detects the reorg
// and rolls back.
async function reindexReplacementChain(seeder) {
    await decoderQuery('DELETE FROM transactions WHERE block_index >= 101');
    await decoderQuery('DELETE FROM blocks WHERE block_index >= 101');
    await seeder.seedReorgEvent([101]);

    // Seed replacement chain: block 101 only mints 75 (no send to ADDR2)
    seeder.reset();
    // Re-cache ADDR1 since decoder still has the address from block 100
    await seeder.seedBlock(101, BASE_TIME + 10, [
        { source: ADDR1, data: 'MINT|0|RTOK|75' }
    ]);

    const indexer = await initIndexer();
    await processBlocks(indexer);
    return indexer;
}

// Verify post-reorg state via API
async function assertPostReorgState(client) {
    let res = await client.get(`/${COIN}/api/token/RTOK`);
    assertApiOk(res, 'post-reorg token');
    assert.strictEqual(res.body.supply.current, '75',
        'Supply should be 75 after reorg (not 200)');

    // ADDR1 should have 75 (only the replacement mint)
    res = await client.get(`/${COIN}/api/balances/${ADDR1}`);
    assertApiOk(res, 'post-reorg balance ADDR1');
    assertBalanceEntry(res.body, 'RTOK', '75');

    // ADDR2 should have no balance (the send was in the rolled-back chain)
    res = await client.get(`/${COIN}/api/balances/${ADDR2}`);
    assertApiOk(res, 'post-reorg balance ADDR2');
    // Either no data or no RTOK entry
    if (res.body.data && res.body.data.length > 0) {
        const entry = res.body.data.find(d => d.tick === 'RTOK');
        assert.ok(!entry, 'ADDR2 should not have RTOK after reorg');
    }

    // Sends endpoint should show no sends (the block 102 send was rolled back)
    res = await client.get(`/${COIN}/api/sends/${ADDR1}/source`);
    assertApiOk(res, 'post-reorg sends');
    assert.strictEqual(res.body.total, 0, 'No sends should exist after reorg');

    // Mints should show only 1 (the replacement mint)
    res = await client.get(`/${COIN}/api/mints/${ADDR1}/address`);
    assertApiOk(res, 'post-reorg mints');
    assertListResponse(res.body, 1, 'post-reorg mints');
    assert.strictEqual(res.body.total, 1, 'Should have exactly 1 mint after reorg');
}

describe('E2E: Blockchain Reorganization @regression @tier3', function () {
    this.timeout(60000);

    let server, port, explorer, client;

    before(async function () {
        await createDatabases(__filename);
        await createDecoderSchema();
        ({ server, port, explorer } = await startExplorer());
        client = createClient(port);
    });

    after(async function () {
        // Sweep any indexer a failed test or partial init left live: each forks a VM worker subprocess that outlives the suite otherwise.
        await destroyFileIndexers(__filename);
        await stopExplorer(server, explorer);
        await closeAll();
    });

    // -------------------------------------------------------------------
    // Basic reorg: rollback and re-index with different data
    // -------------------------------------------------------------------
    it('reorg replaces old state with new chain data in API', async function () {
        const { seeder, indexer } = await indexOriginalChain(explorer);
        await assertPreReorgState(client);
        await destroyIndexer(indexer);

        const replacementIndexer = await reindexReplacementChain(seeder);
        await assertPostReorgState(client);
        await destroyIndexer(replacementIndexer);
    });
});
