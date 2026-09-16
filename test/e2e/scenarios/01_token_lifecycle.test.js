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
 * E2E Test: Token Lifecycle (ISSUE → MINT → SEND → DESTROY)
 *
 * Verifies the complete data pipeline from decoder DB through the indexer
 * into the explorer API. Each action is verified via HTTP API responses.
 */

'use strict';

const assert = require('assert');
const { decoderQuery, indexerQuery, createDatabases, createDecoderSchema,
        resetDecoderDb, resetIndexerDb, closeAll } = require('../../integration/setup/db-connection');
const DecoderSeeder = require('../../integration/setup/decoder-seeder');
const { initIndexer, processBlocks, destroyIndexer, destroyFileIndexers } = require('../../integration/setup/indexer-launcher');
const { startExplorer, stopExplorer, resetExplorerPools } = require('../setup/explorer-launcher');
const { createClient } = require('../setup/api-client');
const { assertApiOk, assertListResponse, assertTokenFields,
        assertBalanceEntry, assertDataContains } = require('../setup/api-assertions');

// Test addresses (30 chars each, valid crypto address length)
const ADDR1 = 'mAddr1XXXXXXXXXXXXXXXXXXXXXXX1'; // issuer
const ADDR2 = 'mAddr2XXXXXXXXXXXXXXXXXXXXXXX2'; // minter/recipient
const ADDR3 = 'mAddr3XXXXXXXXXXXXXXXXXXXXXXX3'; // recipient

const BASE_TIME = 1700000000;
const COIN = 'RBTC'; // regtest BTC prefix

let server, port, explorer, client;
let seeder, indexer;

function registerTokenLifecycleGroup1() {
describe('complete token lifecycle', function () {

        beforeEach(async function () {
            // Block 100: Issue LFTOKEN
            await seeder.seedBlock(100, BASE_TIME, [
                { source: ADDR1, data: 'ISSUE|0|LFTOKEN|10000|1000|0|Lifecycle test token' }
            ]);
            // Block 101: Mint 500 to ADDR1, mint 300 to ADDR2
            await seeder.seedBlock(101, BASE_TIME + 10, [
                { source: ADDR1, data: 'MINT|0|LFTOKEN|500' },
                { source: ADDR1, data: 'MINT|0|LFTOKEN|300|' + ADDR2 }
            ]);
            // Block 102: ADDR1 sends 100 to ADDR3 with memo
            await seeder.seedBlock(102, BASE_TIME + 20, [
                { source: ADDR1, data: 'SEND|0|LFTOKEN|100|' + ADDR3 + '|payment' }
            ]);
            // Block 103: ADDR1 destroys 50
            await seeder.seedBlock(103, BASE_TIME + 30, [
                { source: ADDR1, data: 'DESTROY|0|LFTOKEN|50' }
            ]);

            await processBlocks(indexer);
        });

        registerTokenLifecycleCase1()

        registerTokenLifecycleCase2()

        registerTokenLifecycleCase3()

        registerTokenLifecycleCase4()

        registerTokenLifecycleCase5()

        registerTokenLifecycleCase6()

        registerTokenLifecycleCase7()

        registerTokenLifecycleCase8()

        registerTokenLifecycleCase9()

        registerTokenLifecycleCase10()

        registerTokenLifecycleCase11()

        registerTokenLifecycleCase12()

        registerTokenLifecycleCase13()
    });
}

function registerTokenLifecycleGroup2() {
describe('ISSUE format variants', function () {

        it('re-ISSUE by owner updates description (format 1)', async function () {
            await seeder.seedBlock(100, BASE_TIME, [
                { source: ADDR1, data: 'ISSUE|0|EDITME|1000|100|0|Original' }
            ]);
            await seeder.seedBlock(101, BASE_TIME + 10, [
                { source: ADDR1, data: 'ISSUE|1|EDITME|Updated description' }
            ]);
            await processBlocks(indexer);

            const res = await client.get(`/${COIN}/api/token/EDITME`);
            assertApiOk(res, 'token');
            assert.strictEqual(res.body.info.description, 'Updated description');
        });

        it('re-ISSUE by non-owner is invalid', async function () {
            await seeder.seedBlock(100, BASE_TIME, [
                { source: ADDR1, data: 'ISSUE|0|OWNED|1000|100|0|Mine' }
            ]);
            await seeder.seedBlock(101, BASE_TIME + 10, [
                { source: ADDR2, data: 'ISSUE|1|OWNED|Stolen' }
            ]);
            await processBlocks(indexer);

            // Token description should still be the original
            const res = await client.get(`/${COIN}/api/token/OWNED`);
            assertApiOk(res, 'token');
            assert.strictEqual(res.body.info.description, 'Mine');
            assert.strictEqual(res.body.info.owner, ADDR1);
        });
    });
}

function registerTokenLifecycleGroup3() {
describe('SEND format variants', function () {

        it('multi-send (format 2) creates multiple entries', async function () {
            await seeder.seedBlock(100, BASE_TIME, [
                { source: ADDR1, data: 'ISSUE|0|MSEND|10000|1000|0|Multi-send test' }
            ]);
            await seeder.seedBlock(101, BASE_TIME + 10, [
                { source: ADDR1, data: 'MINT|0|MSEND|1000' }
            ]);
            // Format 2: SEND|2|TICK|AMOUNT|DEST|TICK|AMOUNT|DEST
            await seeder.seedBlock(102, BASE_TIME + 20, [
                { source: ADDR1, data: 'SEND|2|MSEND|100|' + ADDR2 + '|MSEND|200|' + ADDR3 }
            ]);
            await processBlocks(indexer);

            // Check both recipients got tokens
            let res = await client.get(`/${COIN}/api/balances/${ADDR2}`);
            assertApiOk(res, 'balances ADDR2');
            assertBalanceEntry(res.body, 'MSEND', '100');

            res = await client.get(`/${COIN}/api/balances/${ADDR3}`);
            assertApiOk(res, 'balances ADDR3');
            assertBalanceEntry(res.body, 'MSEND', '200');

            // Sends endpoint should show both
            res = await client.get(`/${COIN}/api/sends/MSEND/token`);
            assertApiOk(res, 'sends');
            assertListResponse(res.body, 2, 'multi-send records');
        });
    });
}

function registerTokenLifecycleCase1() {
it('GET /api/token returns correct token info', async function () {
            const res = await client.get(`/${COIN}/api/token/LFTOKEN`);
            assertApiOk(res, 'token');
            assertTokenFields(res.body, {
                tick: 'LFTOKEN',
                owner: ADDR1
            });
            // supply.current = 500 + 300 - 50 = 750 (minted minus destroyed)
            assert.strictEqual(res.body.supply.current, '750',
                'Current supply should be 750 (500+300 minted, 50 destroyed)');
            assert.strictEqual(res.body.supply.max, '10000',
                'Max supply should be 10000');
        });
}

function registerTokenLifecycleCase2() {
it('GET /api/issues by block returns the issuance', async function () {
            const res = await client.get(`/${COIN}/api/issues/100/block`);
            assertApiOk(res, 'issues');
            assertListResponse(res.body, 1, 'issues');
            assertDataContains(res.body, { tick: 'LFTOKEN', status: 'valid' }, 'issue record');
        });
}

function registerTokenLifecycleCase3() {
it('GET /api/mints by address returns mint records', async function () {
            const res = await client.get(`/${COIN}/api/mints/${ADDR1}/address`);
            assertApiOk(res, 'mints');
            assertListResponse(res.body, 2, 'mints');
            // Both mints should be from ADDR1
            for (const row of res.body.data) {
                assert.strictEqual(row.tick, 'LFTOKEN');
                assert.strictEqual(row.status, 'valid');
            }
        });
}

function registerTokenLifecycleCase4() {
it('GET /api/sends by source returns send record', async function () {
            const res = await client.get(`/${COIN}/api/sends/${ADDR1}/source`);
            assertApiOk(res, 'sends');
            assertListResponse(res.body, 1, 'sends');
            assertDataContains(res.body, {
                tick: 'LFTOKEN',
                destination: ADDR3,
                amount: '100',
                status: 'valid'
            }, 'send record');
        });
}

function registerTokenLifecycleCase5() {
it('GET /api/sends by destination returns send record', async function () {
            const res = await client.get(`/${COIN}/api/sends/${ADDR3}/destination`);
            assertApiOk(res, 'sends');
            assertListResponse(res.body, 1, 'sends');
            assertDataContains(res.body, {
                source: ADDR1,
                tick: 'LFTOKEN',
                amount: '100'
            }, 'send by dest');
        });
}

function registerTokenLifecycleCase6() {
it('GET /api/destroys by address returns destroy record', async function () {
            const res = await client.get(`/${COIN}/api/destroys/${ADDR1}/address`);
            assertApiOk(res, 'destroys');
            assertListResponse(res.body, 1, 'destroys');
            assertDataContains(res.body, {
                tick: 'LFTOKEN',
                amount: '50',
                status: 'valid'
            }, 'destroy record');
        });
}

function registerTokenLifecycleCase7() {
it('GET /api/balances returns correct amounts for each address', async function () {
            // ADDR1: 500 minted - 100 sent - 50 destroyed = 350
            let res = await client.get(`/${COIN}/api/balances/${ADDR1}`);
            assertApiOk(res, 'balances ADDR1');
            assertBalanceEntry(res.body, 'LFTOKEN', '350');

            // ADDR2: 300 minted
            res = await client.get(`/${COIN}/api/balances/${ADDR2}`);
            assertApiOk(res, 'balances ADDR2');
            assertBalanceEntry(res.body, 'LFTOKEN', '300');

            // ADDR3: 100 received
            res = await client.get(`/${COIN}/api/balances/${ADDR3}`);
            assertApiOk(res, 'balances ADDR3');
            assertBalanceEntry(res.body, 'LFTOKEN', '100');
        });
}

function registerTokenLifecycleCase8() {
it('GET /api/holders returns all 3 holders', async function () {
            const res = await client.get(`/${COIN}/api/holders/LFTOKEN`);
            assertApiOk(res, 'holders');
            assertListResponse(res.body, 3, 'holders');
        });
}

function registerTokenLifecycleCase9() {
it('GET /api/credits by address shows credit entries', async function () {
            // ADDR3 should have at least one credit for the SEND it received
            const res = await client.get(`/${COIN}/api/credits/${ADDR3}/address`);
            assertApiOk(res, 'credits');
            assertListResponse(res.body, 1, 'credits');
            assertDataContains(res.body, { tick: 'LFTOKEN', amount: '100' }, 'credit');
        });
}

function registerTokenLifecycleCase10() {
it('GET /api/debits by address shows debit entries', async function () {
            // ADDR1 should have debits for the SEND and DESTROY
            const res = await client.get(`/${COIN}/api/debits/${ADDR1}/address`);
            assertApiOk(res, 'debits');
            assertListResponse(res.body, 1, 'debits');
        });
}

function registerTokenLifecycleCase11() {
it('GET /api/history by token shows all actions', async function () {
            const res = await client.get(`/${COIN}/api/history/LFTOKEN/token`);
            assertApiOk(res, 'history');
            assertListResponse(res.body, 1, 'history');
        });
}

function registerTokenLifecycleCase12() {
it('GET /api/block returns block info', async function () {
            const res = await client.get(`/${COIN}/api/block/100`);
            assertApiOk(res, 'block');
            assert.ok(res.body.block_index !== undefined, 'Block response should have block_index');
        });
}

function registerTokenLifecycleCase13() {
it('GET /api/status returns explorer config', async function () {
            const res = await client.get(`/${COIN}/api/status`);
            assertApiOk(res, 'status');
        });
}

function registerTokenLifecycleHook1() {
before(async function () {
        await createDatabases(__filename);
        await createDecoderSchema();
        ({ server, port, explorer } = await startExplorer());
        client = createClient(port);
    });
}

function registerTokenLifecycleHook2() {
after(async function () {
        // Sweep any indexer a failed test or partial init left live: each forks a VM worker subprocess that outlives the suite otherwise.
        await destroyFileIndexers(__filename);
        await stopExplorer(server, explorer);
        await closeAll();
    });
}

function registerTokenLifecycleHook3() {
beforeEach(async function () {
        await resetDecoderDb();
        await resetIndexerDb();
        await resetExplorerPools(explorer);
        seeder = new DecoderSeeder(decoderQuery);
        indexer = await initIndexer();
    });
}

function registerTokenLifecycleHook4() {
afterEach(async function () {
        await destroyIndexer(indexer);
    });
}

describe('E2E: Token Lifecycle @regression @tier3', function () {
    this.timeout(60000);

    registerTokenLifecycleHook1()

    registerTokenLifecycleHook2()

    registerTokenLifecycleHook3()

    registerTokenLifecycleHook4()

    // -------------------------------------------------------------------
    // Full lifecycle: ISSUE → MINT → SEND → DESTROY
    // -------------------------------------------------------------------

registerTokenLifecycleGroup1()

    // -------------------------------------------------------------------
    // ISSUE format variants
    // -------------------------------------------------------------------
    registerTokenLifecycleGroup2()

    // -------------------------------------------------------------------
    // SEND format variants
    // -------------------------------------------------------------------
    registerTokenLifecycleGroup3()
});
