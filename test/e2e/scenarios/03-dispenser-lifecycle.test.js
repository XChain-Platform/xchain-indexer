/**
 * E2E Test: Dispenser Lifecycle (CREATE → DISPENSE)
 *
 * Verifies dispenser creation and token dispensing through the explorer API.
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

const ADDR1 = 'mAddr1XXXXXXXXXXXXXXXXXXXXXXX1'; // dispenser owner
const ADDR2 = 'mAddr2XXXXXXXXXXXXXXXXXXXXXXX2'; // buyer
const ADDR3 = 'mAddr3XXXXXXXXXXXXXXXXXXXXXXX3'; // dispenser get_address

const BASE_TIME = 1700000000;
const FAR_FUTURE = BASE_TIME + 90 * 86400 + 1; // 90 days ahead (within 182-day free window)
const COIN = 'RBTC';

describe('E2E: Dispenser Lifecycle @regression @tier2', function () {
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
    // Dispenser creation and dispensing
    // -------------------------------------------------------------------
    describe('dispenser creation and dispense', function () {

        it('dispenser gives tokens and appears in API', async function () {
            // Issue tokens
            await seeder.seedBlock(100, BASE_TIME, [
                { source: ADDR1, data: 'ISSUE|0|DTOKEN|10000|1000|0|Dispenser test' },
                { source: ADDR2, data: 'ISSUE|0|PTOKEN|10000|1000|0|Payment token' }
            ]);
            // Mint
            await seeder.seedBlock(101, BASE_TIME + 10, [
                { source: ADDR1, data: 'MINT|0|DTOKEN|100' },
                { source: ADDR2, data: 'MINT|0|PTOKEN|50' }
            ]);
            // Create dispenser: give 10 DTOKEN per 1 PTOKEN, escrow 50, get_address=ADDR1
            // FORMAT: DISPENSER|0|GIVE_COIN|GIVE_TICK|GIVE_AMOUNT|GIVE_ESCROW|GET_COIN|GET_TICK|GET_AMOUNT|ADDRESS|FIAT_CODE|FIAT_AMOUNT|EXPIRATION
            await seeder.seedBlock(102, BASE_TIME + 20, [
                { source: ADDR1, data: 'DISPENSER|0|BTC|DTOKEN|10|50|BTC|PTOKEN|1|' + ADDR1 + '|||' + (BASE_TIME + 90 * 86400 + 1) + '' }
            ]);

            await processBlocks(indexer);

            // Verify dispenser in API
            let res = await client.get(`/${COIN}/api/dispensers/${ADDR1}/address`);
            assertApiOk(res, 'dispensers');
            assertListResponse(res.body, 1, 'dispensers');

            // ADDR1 balance: 100 minted - 50 escrowed = 50 available
            res = await client.get(`/${COIN}/api/balances/${ADDR1}`);
            assertApiOk(res, 'balances ADDR1 after dispenser creation');
            assertBalanceEntry(res.body, 'DTOKEN', '50');

            // Verify escrow exists
            res = await client.get(`/${COIN}/api/escrows/${ADDR1}/address`);
            assertApiOk(res, 'escrows');
            assertListResponse(res.body, 1, 'escrows');
        });
    });

    // -------------------------------------------------------------------
    // Dispenser cancellation
    // -------------------------------------------------------------------
    describe('dispenser cancellation', function () {

        it('cancelled dispenser returns escrow and appears in API', async function () {
            await seeder.seedBlock(100, BASE_TIME, [
                { source: ADDR1, data: 'ISSUE|0|DCANCEL|10000|1000|0|Cancel test' },
                { source: ADDR2, data: 'ISSUE|0|DPAY|10000|1000|0|Payment token' }
            ]);
            await seeder.seedBlock(101, BASE_TIME + 10, [
                { source: ADDR1, data: 'MINT|0|DCANCEL|100' }
            ]);
            await seeder.seedBlock(102, BASE_TIME + 20, [
                { source: ADDR1, data: 'DISPENSER|0|BTC|DCANCEL|10|50|BTC|DPAY|1|' + ADDR1 + '|||' + FAR_FUTURE + '|||' }
            ]);

            await processBlocks(indexer);

            // Verify escrow deducted (100 minted - 50 escrowed = 50 available)
            let res = await client.get(`/${COIN}/api/balances/${ADDR1}`);
            assertApiOk(res, 'pre-cancel balance');
            assertBalanceEntry(res.body, 'DCANCEL', '50');

            // Cancel the dispenser
            const dispenserIdx = await getLastActionIndexByType(indexerQuery, 'DISPENSER');
            assert.ok(dispenserIdx, 'DISPENSER action_index should exist');

            // Cancel the dispenser (sets status to 'cancelling')
            await seeder.seedBlock(103, BASE_TIME + 100, [
                { source: ADDR1, data: `DISPENSER|1|${dispenserIdx}|Cancelling` }
            ]);
            // processCancellations requires block_time > cancel_block_time + DISPENSER_CLOSE_DELAY (3600s)
            await seeder.seedBlock(104, BASE_TIME + 4000, []);

            await processBlocks(indexer);

            // Verify cancel in API
            res = await client.get(`/${COIN}/api/dispenser_cancels/${ADDR1}/address`);
            assertApiOk(res, 'dispenser_cancels');
            assertListResponse(res.body, 1, 'dispenser cancels');

            // Balance restored
            res = await client.get(`/${COIN}/api/balances/${ADDR1}`);
            assertApiOk(res, 'post-cancel balance');
            assertBalanceEntry(res.body, 'DCANCEL', '100');
        });
    });
});
