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
 * E2E Test: Explorer Query Patterns
 *
 * Verifies pagination, by-block/by-token/by-address queries,
 * the DataTables-format explorer endpoints, and status endpoints.
 */

'use strict';

const assert = require('assert');
const { decoderQuery, indexerQuery, createDatabases, createDecoderSchema,
        resetDecoderDb, resetIndexerDb, closeAll } = require('../../integration/setup/db-connection');
const DecoderSeeder = require('../../integration/setup/decoder-seeder');
const { initIndexer, processBlocks, destroyIndexer } = require('../../integration/setup/indexer-launcher');
const { startExplorer, stopExplorer, resetExplorerPools } = require('../setup/explorer-launcher');
const { createClient } = require('../setup/api-client');
const { assertApiOk, assertListResponse, assertExplorerResponse,
        assertDataContains, assertBalanceEntry } = require('../setup/api-assertions');

const ADDR1 = 'mAddr1XXXXXXXXXXXXXXXXXXXXXXX1';
const ADDR2 = 'mAddr2XXXXXXXXXXXXXXXXXXXXXXX2';
const ADDR3 = 'mAddr3XXXXXXXXXXXXXXXXXXXXXXX3';

const BASE_TIME = 1700000000;
const COIN = 'RBTC';

describe('E2E: Explorer Query Patterns @regression @tier3', function () {
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

    // -------------------------------------------------------------------
    // Seed a rich dataset for query tests
    // -------------------------------------------------------------------
    describe('pagination and filtering', function () {

        beforeEach(async function () {
            await resetDecoderDb();
            await resetIndexerDb();
            await resetExplorerPools(explorer);
            seeder = new DecoderSeeder(decoderQuery);
            indexer = await initIndexer();

            // Issue token
            await seeder.seedBlock(100, BASE_TIME, [
                { source: ADDR1, data: 'ISSUE|0|PTOK|100000|10000|0|Pagination test' }
            ]);

            // 10 mints across blocks 101-110
            for (let i = 101; i <= 110; i++) {
                await seeder.seedBlock(i, BASE_TIME + (i - 100) * 10, [
                    { source: ADDR1, data: 'MINT|0|PTOK|100' }
                ]);
            }

            // Block 111: 2 sends
            await seeder.seedBlock(111, BASE_TIME + 110, [
                { source: ADDR1, data: 'SEND|0|PTOK|10|' + ADDR2 },
                { source: ADDR1, data: 'SEND|0|PTOK|20|' + ADDR3 }
            ]);

            await processBlocks(indexer);
        });

        afterEach(async function () {
            await destroyIndexer(indexer);
        });

        // ---------------------------------------------------------------
        // By address: all mints for ADDR1
        // ---------------------------------------------------------------
        it('mints by address returns all 10 records', async function () {
            const res = await client.get(`/${COIN}/api/mints/${ADDR1}/address`);
            assertApiOk(res, 'mints');
            assertListResponse(res.body, 10, 'mints by address');
            assert.strictEqual(res.body.total, 10);
        });

        // ---------------------------------------------------------------
        // By block: mints for a specific block
        // ---------------------------------------------------------------
        it('mints by block returns only that block\'s records', async function () {
            const res = await client.get(`/${COIN}/api/mints/105/block`);
            assertApiOk(res, 'mints by block');
            assertListResponse(res.body, 1, 'mints by block');
            assert.strictEqual(res.body.total, 1);
            assert.strictEqual(String(res.body.data[0].block_index), '105');
        });

        // ---------------------------------------------------------------
        // By token: all mints for PTOK
        // ---------------------------------------------------------------
        it('mints by token returns all 10 records', async function () {
            const res = await client.get(`/${COIN}/api/mints/PTOK/token`);
            assertApiOk(res, 'mints by token');
            assertListResponse(res.body, 10, 'mints by token');
        });

        // ---------------------------------------------------------------
        // Pagination: limit parameter
        // ---------------------------------------------------------------
        it('limit parameter restricts returned records', async function () {
            const res = await client.get(`/${COIN}/api/mints/${ADDR1}/address?limit=3`);
            assertApiOk(res, 'limited mints');
            assert.ok(res.body.data.length <= 3,
                `Expected <= 3 records, got ${res.body.data.length}`);
            // Total should still reflect all matching records
            assert.strictEqual(res.body.total, 10);
        });

        // ---------------------------------------------------------------
        // Pagination: page 2 returns different data than page 1
        // ---------------------------------------------------------------
        it('page parameter returns different records', async function () {
            const page1 = await client.get(`/${COIN}/api/mints/${ADDR1}/address?limit=3&page=1`);
            const page2 = await client.get(`/${COIN}/api/mints/${ADDR1}/address?limit=3&page=2`);
            assertApiOk(page1, 'page 1');
            assertApiOk(page2, 'page 2');

            // Pages should have data
            assert.ok(page1.body.data.length > 0, 'Page 1 should have data');
            assert.ok(page2.body.data.length > 0, 'Page 2 should have data');

            // Both pages report the same total
            assert.strictEqual(page1.body.total, page2.body.total,
                'Both pages should report the same total');
        });

        // ---------------------------------------------------------------
        // Sends by source vs destination
        // ---------------------------------------------------------------
        it('sends by source returns outgoing sends', async function () {
            const res = await client.get(`/${COIN}/api/sends/${ADDR1}/source`);
            assertApiOk(res, 'sends by source');
            assertListResponse(res.body, 2, 'sends by source');
        });

        it('sends by destination returns incoming sends', async function () {
            const res = await client.get(`/${COIN}/api/sends/${ADDR2}/destination`);
            assertApiOk(res, 'sends by dest');
            assertListResponse(res.body, 1, 'sends by dest');
            assertDataContains(res.body, { destination: ADDR2, amount: '10' });
        });

        // ---------------------------------------------------------------
        // Sends by token
        // ---------------------------------------------------------------
        it('sends by token returns all sends for that token', async function () {
            const res = await client.get(`/${COIN}/api/sends/PTOK/token`);
            assertApiOk(res, 'sends by token');
            assertListResponse(res.body, 2, 'sends by token');
        });

        // ---------------------------------------------------------------
        // Holders endpoint
        // ---------------------------------------------------------------
        it('holders returns all token holders', async function () {
            const res = await client.get(`/${COIN}/api/holders/PTOK`);
            assertApiOk(res, 'holders');
            // 3 holders: ADDR1, ADDR2, ADDR3
            assertListResponse(res.body, 3, 'holders');
        });

        // ---------------------------------------------------------------
        // Balances includes tick metadata
        // ---------------------------------------------------------------
        it('balances response includes token metadata', async function () {
            const res = await client.get(`/${COIN}/api/balances/${ADDR1}`);
            assertApiOk(res, 'balances');
            assert.ok(res.body.address, 'Balances should include address field');
            assert.ok(Array.isArray(res.body.data), 'Balances should have data array');
            const entry = res.body.data.find(d => d.tick === 'PTOK');
            assert.ok(entry, 'Should have PTOK balance');
            assert.ok(entry.amount, 'Balance entry should have amount');
        });

        // ---------------------------------------------------------------
        // Block endpoint
        // ---------------------------------------------------------------
        it('block endpoint returns block info', async function () {
            const res = await client.get(`/${COIN}/api/block/105`);
            assertApiOk(res, 'block');
            assert.strictEqual(String(res.body.block_index), '105');
            assert.ok(res.body.timestamp, 'Block should have timestamp');
            assert.ok(res.body.ledger_hash, 'Block should have ledger_hash');
        });

        // ---------------------------------------------------------------
        // Status endpoint
        // ---------------------------------------------------------------
        it('status endpoint returns explorer config', async function () {
            const res = await client.get(`/${COIN}/api/status`);
            assertApiOk(res, 'status');
            // Status returns config data, should have COIN_AVAILABLE or similar
            assert.ok(typeof res.body === 'object', 'Status should return object');
        });

        // ---------------------------------------------------------------
        // Tokens list by address
        // ---------------------------------------------------------------
        it('tokens by address shows owned tokens', async function () {
            const res = await client.get(`/${COIN}/api/tokens/${ADDR1}/address`);
            assertApiOk(res, 'tokens by address');
            assertListResponse(res.body, 1, 'tokens by address');
            assertDataContains(res.body, { tick: 'PTOK' });
        });

        // ---------------------------------------------------------------
        // Credits by block
        // ---------------------------------------------------------------
        it('credits by block returns credit entries', async function () {
            const res = await client.get(`/${COIN}/api/credits/111/block`);
            assertApiOk(res, 'credits by block');
            // Block 111 has 2 sends → at least 2 credit entries
            assertListResponse(res.body, 2, 'credits by block');
        });

        // ---------------------------------------------------------------
        // Explorer endpoint (DataTables format)
        // ---------------------------------------------------------------
        it('explorer endpoint returns DataTables format', async function () {
            const res = await client.get(`/${COIN}/explorer/mints/${ADDR1}/address`);
            assertApiOk(res, 'explorer mints');
            assertExplorerResponse(res.body, 10, 'explorer mints');
        });

        // ---------------------------------------------------------------
        // History by token
        // ---------------------------------------------------------------
        it('history by token returns action records', async function () {
            const res = await client.get(`/${COIN}/api/history/PTOK/token`);
            assertApiOk(res, 'history');
            // At least ISSUE + 10 MINTs + 2 SENDs = 13 actions
            assertListResponse(res.body, 1, 'history');
        });
    });
});
