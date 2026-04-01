/**
 * E2E Test: Order Lifecycle (CREATE → MATCH → CANCEL)
 *
 * Verifies DEX order creation, automatic matching, and cancellation
 * through the explorer API endpoints including market views.
 */

'use strict';

const assert = require('assert');
const { decoderQuery, indexerQuery, createDatabases, createDecoderSchema,
        resetDecoderDb, resetIndexerDb, closeAll } = require('../../integration/setup/db-connection');
const DecoderSeeder = require('../../integration/setup/decoder-seeder');
const { initIndexer, processBlocks, destroyIndexer } = require('../../integration/setup/indexer-launcher');
const { getLastActionIndexByType } = require('../../integration/setup/assertion-helpers');
const { startExplorer, stopExplorer, resetExplorerPools } = require('../setup/explorer-launcher');
const { createClient } = require('../setup/api-client');
const { assertApiOk, assertListResponse, assertDataContains,
        assertBalanceEntry } = require('../setup/api-assertions');

const ADDR1 = 'mAddr1XXXXXXXXXXXXXXXXXXXXXXX1';
const ADDR2 = 'mAddr2XXXXXXXXXXXXXXXXXXXXXXX2';

const BASE_TIME = 1700000000;
const FAR_FUTURE = BASE_TIME + 90 * 86400 + 1; // 90 days ahead (within 182-day free window)
const COIN = 'RBTC';

describe('E2E: Order Lifecycle', function () {
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
    // Order creation and matching
    // -------------------------------------------------------------------
    describe('order creation and matching', function () {

        it('matched orders transfer balances and appear in API', async function () {
            // Issue two tokens
            await seeder.seedBlock(100, BASE_TIME, [
                { source: ADDR1, data: 'ISSUE|0|TOKENA|10000|1000|0|Token A' },
                { source: ADDR2, data: 'ISSUE|0|TOKENB|10000|1000|0|Token B' }
            ]);
            // Mint supply
            await seeder.seedBlock(101, BASE_TIME + 10, [
                { source: ADDR1, data: 'MINT|0|TOKENA|500' },
                { source: ADDR2, data: 'MINT|0|TOKENB|500' }
            ]);
            // ADDR1 creates order: give 100 TOKENA, get 100 TOKENB (expiration = far future timestamp)
            // FORMAT: ORDER|0|GIVE_COIN|GIVE_TICK|GIVE_AMOUNT|GET_COIN|GET_TICK|GET_AMOUNT|GET_ADDRESS|EXPIRATION
            await seeder.seedBlock(102, BASE_TIME + 20, [
                { source: ADDR1, data: `ORDER|0|BTC|TOKENA|100|BTC|TOKENB|100||${FAR_FUTURE}` }
            ]);
            // ADDR2 creates matching counter-order: give 100 TOKENB, get 100 TOKENA
            await seeder.seedBlock(103, BASE_TIME + 30, [
                { source: ADDR2, data: `ORDER|0|BTC|TOKENB|100|BTC|TOKENA|100||${FAR_FUTURE}` }
            ]);

            await processBlocks(indexer);

            // Verify orders appear in API
            let res = await client.get(`/${COIN}/api/orders/${ADDR1}/address`);
            assertApiOk(res, 'orders ADDR1');
            assertListResponse(res.body, 1, 'ADDR1 orders');
            assertDataContains(res.body, { source: ADDR1 }, 'ADDR1 order');

            // Verify order matches exist
            res = await client.get(`/${COIN}/api/order_matches/103/block`);
            assertApiOk(res, 'order_matches');
            assertListResponse(res.body, 1, 'order matches');

            // Verify balances transferred
            // ADDR1: started with 500 TOKENA, gave 100, should have 400 TOKENA + 100 TOKENB
            res = await client.get(`/${COIN}/api/balances/${ADDR1}`);
            assertApiOk(res, 'balances ADDR1');
            assertBalanceEntry(res.body, 'TOKENA', '400');
            assertBalanceEntry(res.body, 'TOKENB', '100');

            // ADDR2: started with 500 TOKENB, gave 100, should have 400 TOKENB + 100 TOKENA
            res = await client.get(`/${COIN}/api/balances/${ADDR2}`);
            assertApiOk(res, 'balances ADDR2');
            assertBalanceEntry(res.body, 'TOKENB', '400');
            assertBalanceEntry(res.body, 'TOKENA', '100');
        });
    });

    // -------------------------------------------------------------------
    // Order cancellation (two-phase: process, get action_index, cancel)
    // -------------------------------------------------------------------
    describe('order cancellation', function () {

        it('cancelled order returns escrowed tokens and appears in API', async function () {
            // Phase 1: Create tokens and an open order
            await seeder.seedBlock(100, BASE_TIME, [
                { source: ADDR1, data: 'ISSUE|0|CANCEL1|10000|1000|0|Cancel test' },
                { source: ADDR2, data: 'ISSUE|0|WANTOK|10000|1000|0|Want token' }
            ]);
            await seeder.seedBlock(101, BASE_TIME + 10, [
                { source: ADDR1, data: 'MINT|0|CANCEL1|500' }
            ]);
            // Create order: give 200 CANCEL1, get 50 WANTOK
            await seeder.seedBlock(102, BASE_TIME + 20, [
                { source: ADDR1, data: `ORDER|0|BTC|CANCEL1|200|BTC|WANTOK|50|${ADDR1}|${FAR_FUTURE}|||` }
            ]);

            await processBlocks(indexer);

            // ADDR1 balance should be 300 (500 - 200 escrowed)
            let res = await client.get(`/${COIN}/api/balances/${ADDR1}`);
            assertApiOk(res, 'balances pre-cancel');
            assertBalanceEntry(res.body, 'CANCEL1', '300');

            // Phase 2: Cancel the order
            const orderActionIndex = await getLastActionIndexByType(indexerQuery, 'ORDER');
            assert.ok(orderActionIndex, 'ORDER action_index should exist');

            await seeder.seedBlock(103, BASE_TIME + 30, [
                { source: ADDR1, data: `ORDER|1|${orderActionIndex}|Cancelling` }
            ]);

            await processBlocks(indexer);

            // Verify cancel record in API
            res = await client.get(`/${COIN}/api/order_cancels/${ADDR1}/address`);
            assertApiOk(res, 'order_cancels');
            assertListResponse(res.body, 1, 'order cancels');

            // Balance should be restored to 500
            res = await client.get(`/${COIN}/api/balances/${ADDR1}`);
            assertApiOk(res, 'balances post-cancel');
            assertBalanceEntry(res.body, 'CANCEL1', '500');
        });
    });

    // -------------------------------------------------------------------
    // Order expiration
    // -------------------------------------------------------------------
    describe('order expiration', function () {

        it('expired order appears in order_expires endpoint', async function () {
            // Expiration at BASE_TIME + 25 (between block 102 and 103)
            const EXPIRE_TIME = BASE_TIME + 25;

            await seeder.seedBlock(100, BASE_TIME, [
                { source: ADDR1, data: 'ISSUE|0|EXPIRY1|10000|1000|0|Expiry test' },
                { source: ADDR2, data: 'ISSUE|0|EXWANT|10000|1000|0|Expiry want' }
            ]);
            await seeder.seedBlock(101, BASE_TIME + 10, [
                { source: ADDR1, data: 'MINT|0|EXPIRY1|500' }
            ]);
            // Order with short expiration: give EXPIRY1, get EXWANT
            await seeder.seedBlock(102, BASE_TIME + 20, [
                { source: ADDR1, data: `ORDER|0|BTC|EXPIRY1|100|BTC|EXWANT|50|${ADDR1}|${EXPIRE_TIME}|||` }
            ]);
            // Block 103 time > EXPIRE_TIME triggers expiration
            await seeder.seedBlock(103, BASE_TIME + 30, []);
            await seeder.seedBlock(104, BASE_TIME + 40, []);

            await processBlocks(indexer);

            // Verify order_expires
            const res = await client.get(`/${COIN}/api/order_expires/${ADDR1}/address`);
            assertApiOk(res, 'order_expires');
            assertListResponse(res.body, 1, 'order expires');

            // Balance should be fully restored after expiration
            const bRes = await client.get(`/${COIN}/api/balances/${ADDR1}`);
            assertApiOk(bRes, 'balances post-expire');
            assertBalanceEntry(bRes.body, 'EXPIRY1', '500');
        });
    });
});
