/**
 * E2E Test: Error Handling and Invalid Actions
 *
 * Verifies that invalid actions do not corrupt the database state,
 * and that the explorer API correctly reflects valid-only state.
 */

'use strict';

const assert = require('assert');
const { decoderQuery, indexerQuery, createDatabases, createDecoderSchema,
        resetDecoderDb, resetIndexerDb, closeAll } = require('../../integration/setup/db-connection');
const DecoderSeeder = require('../../integration/setup/decoder-seeder');
const { initIndexer, processBlocks, destroyIndexer } = require('../../integration/setup/indexer-launcher');
const { startExplorer, stopExplorer, resetExplorerPools } = require('../setup/explorer-launcher');
const { createClient } = require('../setup/api-client');
const { assertApiOk, assertListResponse, assertBalanceEntry,
        assertDataContains, assertNoBalanceEntry } = require('../setup/api-assertions');

const ADDR1 = 'mAddr1XXXXXXXXXXXXXXXXXXXXXXX1';
const ADDR2 = 'mAddr2XXXXXXXXXXXXXXXXXXXXXXX2';
const ADDR3 = 'mAddr3XXXXXXXXXXXXXXXXXXXXXXX3';

const BASE_TIME = 1700000000;
const COIN = 'RBTC';

describe('E2E: Error Handling @regression @tier3', function () {
    this.timeout(60000);

    let server, port, explorer, client;
    let seeder, indexer;

    before(async function () {
        await createDatabases();
        await createDecoderSchema();
        ({ server, port, explorer } = await startExplorer());
        client = createClient(port);
    });

    after(async function () {
        await stopExplorer(server, explorer);
        await closeAll();
    });

    beforeEach(async function () {
        await resetDecoderDb();
        await resetIndexerDb();
        await resetExplorerPools(explorer);
        seeder = new DecoderSeeder(decoderQuery);
        indexer = await initIndexer();
    });

    afterEach(async function () {
        await destroyIndexer(indexer);
    });

    // -------------------------------------------------------------------
    // Insufficient balance for SEND
    // -------------------------------------------------------------------
    it('SEND with insufficient balance does not affect balances', async function () {
        await seeder.seedBlock(100, BASE_TIME, [
            { source: ADDR1, data: 'ISSUE|0|ETOKEN|10000|1000|0|Error test' }
        ]);
        await seeder.seedBlock(101, BASE_TIME + 10, [
            { source: ADDR1, data: 'MINT|0|ETOKEN|100' }
        ]);
        // Try to send more than balance
        await seeder.seedBlock(102, BASE_TIME + 20, [
            { source: ADDR1, data: 'SEND|0|ETOKEN|999|' + ADDR2 }
        ]);

        await processBlocks(indexer);

        // ADDR1 balance unchanged at 100
        let res = await client.get(`/${COIN}/api/balances/${ADDR1}`);
        assertApiOk(res, 'balance ADDR1');
        assertBalanceEntry(res.body, 'ETOKEN', '100');

        // ADDR2 should have no balance
        res = await client.get(`/${COIN}/api/balances/${ADDR2}`);
        assertApiOk(res, 'balance ADDR2');
        assertNoBalanceEntry(res.body, 'ETOKEN');

        // Token supply unchanged
        res = await client.get(`/${COIN}/api/token/ETOKEN`);
        assertApiOk(res, 'token');
        assert.strictEqual(res.body.supply.current, '100');
    });

    // -------------------------------------------------------------------
    // Double-spend in same block
    // -------------------------------------------------------------------
    it('second send in same block fails when balance exhausted', async function () {
        await seeder.seedBlock(100, BASE_TIME, [
            { source: ADDR1, data: 'ISSUE|0|DOUBLE|10000|1000|0|Double spend test' }
        ]);
        await seeder.seedBlock(101, BASE_TIME + 10, [
            { source: ADDR1, data: 'MINT|0|DOUBLE|100' }
        ]);
        // Two sends in the same block — first should succeed, second should fail
        await seeder.seedBlock(102, BASE_TIME + 20, [
            { source: ADDR1, data: 'SEND|0|DOUBLE|80|' + ADDR2 },
            { source: ADDR1, data: 'SEND|0|DOUBLE|80|' + ADDR3 }
        ]);

        await processBlocks(indexer);

        // ADDR1: 100 - 80 = 20 (only first send succeeds)
        let res = await client.get(`/${COIN}/api/balances/${ADDR1}`);
        assertApiOk(res, 'balance ADDR1');
        assertBalanceEntry(res.body, 'DOUBLE', '20');

        // ADDR2 got the 80
        res = await client.get(`/${COIN}/api/balances/${ADDR2}`);
        assertApiOk(res, 'balance ADDR2');
        assertBalanceEntry(res.body, 'DOUBLE', '80');

        // ADDR3 got nothing
        res = await client.get(`/${COIN}/api/balances/${ADDR3}`);
        assertApiOk(res, 'balance ADDR3');
        assertNoBalanceEntry(res.body, 'DOUBLE');
    });

    // -------------------------------------------------------------------
    // SEND to non-existent token
    // -------------------------------------------------------------------
    it('SEND for non-existent token does not crash indexer', async function () {
        await seeder.seedBlock(100, BASE_TIME, [
            { source: ADDR1, data: 'SEND|0|NOEXIST|100|' + ADDR2 }
        ]);

        // Should not throw
        await processBlocks(indexer);

        // ADDR2 should have no balance
        const res = await client.get(`/${COIN}/api/balances/${ADDR2}`);
        assertApiOk(res, 'balance ADDR2');
        assertNoBalanceEntry(res.body, 'NOEXIST');
    });

    // -------------------------------------------------------------------
    // Malformed action data
    // -------------------------------------------------------------------
    it('malformed action data does not crash indexer', async function () {
        await seeder.seedBlock(100, BASE_TIME, [
            { source: ADDR1, data: 'ISSUE|0|GOODTK|10000|1000|0|Valid token' }
        ]);
        // Malformed: too few fields
        await seeder.seedBlock(101, BASE_TIME + 10, [
            { source: ADDR1, data: 'ISSUE|0|' },
            { source: ADDR1, data: 'SEND' },
            { source: ADDR1, data: '' }
        ]);
        // Valid mint after malformed actions
        await seeder.seedBlock(102, BASE_TIME + 20, [
            { source: ADDR1, data: 'MINT|0|GOODTK|50' }
        ]);

        await processBlocks(indexer);

        // Valid token and mint should still work
        let res = await client.get(`/${COIN}/api/token/GOODTK`);
        assertApiOk(res, 'token');
        assert.strictEqual(res.body.supply.current, '50');

        res = await client.get(`/${COIN}/api/balances/${ADDR1}`);
        assertApiOk(res, 'balance');
        assertBalanceEntry(res.body, 'GOODTK', '50');
    });

    // -------------------------------------------------------------------
    // Valid actions after invalid ones in the same block
    // -------------------------------------------------------------------
    it('valid action in same block as invalid action processes correctly', async function () {
        await seeder.seedBlock(100, BASE_TIME, [
            { source: ADDR1, data: 'ISSUE|0|MIXED|10000|1000|0|Mixed block' }
        ]);
        await seeder.seedBlock(101, BASE_TIME + 10, [
            { source: ADDR1, data: 'MINT|0|MIXED|100' }
        ]);
        // Block with invalid THEN valid action
        await seeder.seedBlock(102, BASE_TIME + 20, [
            { source: ADDR1, data: 'SEND|0|MIXED|999|' + ADDR2 },  // invalid: insufficient
            { source: ADDR1, data: 'SEND|0|MIXED|30|' + ADDR3 }     // valid: has 100
        ]);

        await processBlocks(indexer);

        // ADDR1: 100 - 30 = 70
        let res = await client.get(`/${COIN}/api/balances/${ADDR1}`);
        assertApiOk(res, 'balance ADDR1');
        assertBalanceEntry(res.body, 'MIXED', '70');

        // ADDR3 got 30
        res = await client.get(`/${COIN}/api/balances/${ADDR3}`);
        assertApiOk(res, 'balance ADDR3');
        assertBalanceEntry(res.body, 'MIXED', '30');

        // ADDR2 got nothing
        res = await client.get(`/${COIN}/api/balances/${ADDR2}`);
        assertApiOk(res, 'balance ADDR2');
        assertNoBalanceEntry(res.body, 'MIXED');
    });
});
