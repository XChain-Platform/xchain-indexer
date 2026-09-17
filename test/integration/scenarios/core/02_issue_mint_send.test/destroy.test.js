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
 * test/integration/scenarios/core/02_issue_mint_send.test/destroy.test.js
 *
 * The DESTROY cases of the token lifecycle suite: the debit and supply decrement with no
 * credit, an insufficient balance, and the supply sanity check after ISSUE, MINT and SEND.
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
        countRows, assertLedgerEntry, assertSanity } = require('../../../setup/assertion-helpers');
const { ADDR1, ADDR2, BASE_TIME, fileSchemaHooks, freshLifecycleChain } = require('./helpers/lifecycle_chain');

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
    // 13. DESTROY reduces supply: only debits created, supply decremented
    // -----------------------------------------------------------------------
    it('DESTROY creates a debit record and decrements token supply', async function () {
        await seeder.seedBlock(100, BASE_TIME, [
            { source: ADDR1, data: 'ISSUE|0|BURNABLE|5000|1000|0|Burnable token' }
        ]);
        await seeder.seedBlock(101, BASE_TIME + 10, [
            { source: ADDR1, data: 'MINT|0|BURNABLE|500' }
        ]);
        // DESTROY format 0: VERSION|TICK|AMOUNT|MEMO
        await seeder.seedBlock(102, BASE_TIME + 20, [
            { source: ADDR1, data: 'DESTROY|0|BURNABLE|200' }
        ]);

        await processBlocks(indexer);

        // Supply = 500 - 200 = 300
        await assertTokenSupply(indexerQuery, 'BURNABLE', '300');
        // Balance = 500 - 200 = 300
        await assertBalance(indexerQuery, ADDR1, 'BURNABLE', '300');

        const destroyActionIndex = await getLastActionIndexByType(indexerQuery, 'DESTROY');
        await assertActionStatus(indexerQuery, 'destroys', destroyActionIndex, 'valid');
        await assertLedgerEntry(indexerQuery, 'debits', destroyActionIndex, 'BURNABLE', ADDR1, '200');

        // No credits for DESTROY
        const creditCount = await countRows(indexerQuery, 'credits',
            'action_index = ?', [destroyActionIndex]);
        assert.strictEqual(creditCount, 0, 'DESTROY should not create credit entries');
    });

});

describe('ISSUE / MINT / SEND / DESTROY Token Lifecycle @regression @tier1', function () {
    this.timeout(30000);
    before(createFileSchemas);
    beforeEach(freshChainAndIndexer);
    afterEach(stopIndexer);
    after(closeFileSchemas);

    // -----------------------------------------------------------------------
    // 14. DESTROY insufficient balance: invalid
    // -----------------------------------------------------------------------
    it('DESTROY with insufficient balance is marked invalid', async function () {
        await seeder.seedBlock(100, BASE_TIME, [
            { source: ADDR1, data: 'ISSUE|0|UNBURNABLE|1000|200|0|Token' }
        ]);
        await seeder.seedBlock(101, BASE_TIME + 10, [
            { source: ADDR1, data: 'MINT|0|UNBURNABLE|100' }
        ]);
        // Try to destroy 500: only has 100
        await seeder.seedBlock(102, BASE_TIME + 20, [
            { source: ADDR1, data: 'DESTROY|0|UNBURNABLE|500' }
        ]);

        await processBlocks(indexer);

        const destroyActionIndex = await getLastActionIndexByType(indexerQuery, 'DESTROY');
        await assertActionStatus(indexerQuery, 'destroys', destroyActionIndex, 'invalid: insufficient funds');

        // Supply and balance should remain 100
        await assertTokenSupply(indexerQuery, 'UNBURNABLE', '100');
        await assertBalance(indexerQuery, ADDR1, 'UNBURNABLE', '100');
    });

    // -----------------------------------------------------------------------
    // 15. Sanity check passes after ISSUE + MINT + SEND sequence
    // -----------------------------------------------------------------------
    it('sanity check passes: supply == credits - debits == balances after ISSUE+MINT+SEND', async function () {
        await seeder.seedBlock(100, BASE_TIME, [
            { source: ADDR1, data: 'ISSUE|0|SANITY|10000|1000|0|Sanity token' }
        ]);
        await seeder.seedBlock(101, BASE_TIME + 10, [
            { source: ADDR1, data: 'MINT|0|SANITY|800' }
        ]);
        await seeder.seedBlock(102, BASE_TIME + 20, [
            { source: ADDR1, destination: ADDR2, data: 'SEND|0|SANITY|300|' + ADDR2 }
        ]);

        await processBlocks(indexer);

        await assertSanity(indexerQuery, 'SANITY');
    });

});
