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
 * test/integration/scenarios/core/02_issue_mint_send.test/send.test.js
 *
 * The SEND cases of the token lifecycle suite: debits and credits for both sides, an
 * insufficient balance, an invalid destination, a multi-block lifecycle, and two tokens
 * whose balances must not cross.
 *
 * Kept under the entry file's describe title, so every full test title reads as it did
 * when the suite was one file (02_issue_mint_send.test.js holds the ISSUE cases). The actors
 * and the hook bodies are in helpers/lifecycle_chain.js. Needs a disposable MariaDB, like
 * every scenario here.
 */

'use strict';

const assert = require('assert');
const { indexerQuery } = require('../../../setup/db-connection');
const { processBlocks, destroyIndexer } = require('../../../setup/indexer-launcher');
const { assertBalance, assertTokenSupply, assertActionStatus, getLastActionIndexByType,
        countRows, assertLedgerEntry } = require('../../../setup/assertion-helpers');
const { ADDR1, ADDR2, ADDR3, BASE_TIME, fileSchemaHooks, freshLifecycleChain } = require('./helpers/lifecycle_chain');

// The same four hooks every block of 02_issue_mint_send.test.js registers, bound to this
// file's own scoped schemas.
let seeder, indexer;
const { createFileSchemas, closeFileSchemas } = fileSchemaHooks(__filename);

async function freshChainAndIndexer() {
    ({ seeder, indexer } = await freshLifecycleChain());
}

async function stopIndexer() {
    await destroyIndexer(indexer);
}

describe('ISSUE / MINT / SEND / DESTROY Token Lifecycle @regression @tier1', function () {
    this.timeout(30000);
    before(createFileSchemas);
    beforeEach(freshChainAndIndexer);
    afterEach(stopIndexer);
    after(closeFileSchemas);

    // -----------------------------------------------------------------------
    // 9. SEND transfers balance: credits, debits, balances for both addresses
    // -----------------------------------------------------------------------
    it('SEND debits source and credits destination with correct amounts', async function () {
        await seeder.seedBlock(300, BASE_TIME, [
            { source: ADDR1, data: 'ISSUE|0|SENDABLE|5000|1000|0|Sendable token' }
        ]);
        await seeder.seedBlock(301, BASE_TIME + 10, [
            { source: ADDR1, data: 'MINT|0|SENDABLE|500' }
        ]);
        await seeder.seedBlock(302, BASE_TIME + 20, [
            { source: ADDR1, destination: ADDR2, data: 'SEND|0|SENDABLE|200|' + ADDR2 }
        ]);

        await processBlocks(indexer);

        await assertBalance(indexerQuery, ADDR1, 'SENDABLE', '300');
        await assertBalance(indexerQuery, ADDR2, 'SENDABLE', '200');

        const sendActionIndex = await getLastActionIndexByType(indexerQuery, 'SEND');
        await assertLedgerEntry(indexerQuery, 'debits',  sendActionIndex, 'SENDABLE', ADDR1, '200');
        await assertLedgerEntry(indexerQuery, 'credits', sendActionIndex, 'SENDABLE', ADDR2, '200');
    });

});

describe('ISSUE / MINT / SEND / DESTROY Token Lifecycle @regression @tier1', function () {
    this.timeout(30000);
    before(createFileSchemas);
    beforeEach(freshChainAndIndexer);
    afterEach(stopIndexer);
    after(closeFileSchemas);

    // -----------------------------------------------------------------------
    // 10. SEND insufficient balance: status invalid, no ledger changes
    // -----------------------------------------------------------------------
    it('SEND with insufficient balance is marked invalid and creates no ledger entries', async function () {
        await seeder.seedBlock(310, BASE_TIME, [
            { source: ADDR1, data: 'ISSUE|0|SCARCE|100|50|0|Scarce token' }
        ]);
        await seeder.seedBlock(311, BASE_TIME + 10, [
            { source: ADDR1, data: 'MINT|0|SCARCE|50' }
        ]);
        // Try to send 100: ADDR1 only has 50
        await seeder.seedBlock(312, BASE_TIME + 20, [
            { source: ADDR1, destination: ADDR2, data: 'SEND|0|SCARCE|100|' + ADDR2 }
        ]);

        await processBlocks(indexer);

        const sendActionIndex = await getLastActionIndexByType(indexerQuery, 'SEND');
        await assertActionStatus(indexerQuery, 'sends', sendActionIndex, 'invalid: insufficient funds');

        // ADDR1 balance unchanged
        await assertBalance(indexerQuery, ADDR1, 'SCARCE', '50');
        // ADDR2 has no balance
        await assertBalance(indexerQuery, ADDR2, 'SCARCE', null);

        // No ledger entries for this SEND action
        const debitCount = await countRows(indexerQuery, 'debits',
            'action_index = ?', [sendActionIndex]);
        assert.strictEqual(debitCount, 0, 'No debit entries for invalid SEND');
        const creditCount = await countRows(indexerQuery, 'credits',
            'action_index = ?', [sendActionIndex]);
        assert.strictEqual(creditCount, 0, 'No credit entries for invalid SEND');
    });

});

describe('ISSUE / MINT / SEND / DESTROY Token Lifecycle @regression @tier1', function () {
    this.timeout(30000);
    before(createFileSchemas);
    beforeEach(freshChainAndIndexer);
    afterEach(stopIndexer);
    after(closeFileSchemas);

    // -----------------------------------------------------------------------
    // 11. SEND to invalid address: status invalid
    // -----------------------------------------------------------------------
    it('SEND to an invalid destination address is marked invalid', async function () {
        await seeder.seedBlock(320, BASE_TIME, [
            { source: ADDR1, data: 'ISSUE|0|ADDRCHECK|1000|500|0|Address check token' }
        ]);
        await seeder.seedBlock(321, BASE_TIME + 10, [
            { source: ADDR1, data: 'MINT|0|ADDRCHECK|200' }
        ]);
        // Destination is not a valid address (fails isCryptoAddress)
        await seeder.seedBlock(322, BASE_TIME + 20, [
            { source: ADDR1, destination: 'badaddr', data: 'SEND|0|ADDRCHECK|100|badaddr' }
        ]);

        await processBlocks(indexer);

        const sendActionIndex = await getLastActionIndexByType(indexerQuery, 'SEND');
        await assertActionStatus(indexerQuery, 'sends', sendActionIndex, 'invalid: DESTINATION (format)');

        // ADDR1 balance should still be 200
        await assertBalance(indexerQuery, ADDR1, 'ADDRCHECK', '200');
    });

});

describe('ISSUE / MINT / SEND / DESTROY Token Lifecycle @regression @tier1', function () {
    this.timeout(30000);
    before(createFileSchemas);
    beforeEach(freshChainAndIndexer);
    afterEach(stopIndexer);
    after(closeFileSchemas);

    // -----------------------------------------------------------------------
    // 12. Multi-block lifecycle: ISSUE → MINT → SEND → SEND → verify balances
    // -----------------------------------------------------------------------
    it('full lifecycle ISSUE→MINT→SEND→SEND produces correct final balances', async function () {
        await seeder.seedBlock(400, BASE_TIME, [
            { source: ADDR1, data: 'ISSUE|0|LIFECYCLE|10000|2000|0|Lifecycle token' }
        ]);
        await seeder.seedBlock(401, BASE_TIME + 10, [
            { source: ADDR1, data: 'MINT|0|LIFECYCLE|1000' }
        ]);
        await seeder.seedBlock(402, BASE_TIME + 20, [
            { source: ADDR1, destination: ADDR2, data: 'SEND|0|LIFECYCLE|400|' + ADDR2 }
        ]);
        await seeder.seedBlock(403, BASE_TIME + 30, [
            { source: ADDR2, destination: ADDR3, data: 'SEND|0|LIFECYCLE|150|' + ADDR3 }
        ]);

        await processBlocks(indexer);

        // ADDR1: 1000 minted - 400 sent = 600
        await assertBalance(indexerQuery, ADDR1, 'LIFECYCLE', '600');
        // ADDR2: 400 received - 150 sent = 250
        await assertBalance(indexerQuery, ADDR2, 'LIFECYCLE', '250');
        // ADDR3: 150 received
        await assertBalance(indexerQuery, ADDR3, 'LIFECYCLE', '150');

        // Total supply should remain 1000
        await assertTokenSupply(indexerQuery, 'LIFECYCLE', '1000');
    });

});

describe('ISSUE / MINT / SEND / DESTROY Token Lifecycle @regression @tier1', function () {
    this.timeout(30000);
    before(createFileSchemas);
    beforeEach(freshChainAndIndexer);
    afterEach(stopIndexer);
    after(closeFileSchemas);

    // -----------------------------------------------------------------------
    // 20. Multiple tokens coexist independently: balances do not cross
    // -----------------------------------------------------------------------
    it('two independently issued tokens maintain separate balances', async function () {
        await seeder.seedBlock(1100, BASE_TIME, [
            { source: ADDR1, data: 'ISSUE|0|APPLE|1000|500|0|Apple token' },
            { source: ADDR2, data: 'ISSUE|0|ORANGE|2000|1000|0|Orange token' }
        ]);
        await seeder.seedBlock(1101, BASE_TIME + 10, [
            { source: ADDR1, data: 'MINT|0|APPLE|300' },
            { source: ADDR2, data: 'MINT|0|ORANGE|700' }
        ]);

        await processBlocks(indexer);

        // Each address holds only their own token
        await assertBalance(indexerQuery, ADDR1, 'APPLE', '300');
        await assertBalance(indexerQuery, ADDR2, 'ORANGE', '700');

        // Cross-checks: each address should have no balance for the other token
        await assertBalance(indexerQuery, ADDR1, 'ORANGE', null);
        await assertBalance(indexerQuery, ADDR2, 'APPLE', null);

        await assertTokenSupply(indexerQuery, 'APPLE', '300');
        await assertTokenSupply(indexerQuery, 'ORANGE', '700');
    });
});
