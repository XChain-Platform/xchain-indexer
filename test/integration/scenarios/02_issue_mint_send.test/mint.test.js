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
 * test/integration/scenarios/02_issue_mint_send.test/mint.test.js
 *
 * The MINT cases of the token lifecycle suite: the credit, balance and supply a MINT
 * writes, the MAX_MINT and MAX_SUPPLY caps, fractional amounts at 8 decimals, and a MINT
 * to a DESTINATION.
 *
 * Kept under the entry file's describe title, so every full test title reads as it did
 * when the suite was one file (02_issue_mint_send.test.js holds the ISSUE cases). The actors
 * and the hook bodies are in helpers/lifecycle_chain.js. Needs a disposable MariaDB, like
 * every scenario here.
 */

'use strict';

const assert = require('assert');
const { indexerQuery } = require('../../setup/db-connection');
const { processBlocks, destroyIndexer } = require('../../setup/indexer-launcher');
const { assertBalance, assertTokenSupply, assertActionStatus, getLastActionIndexByType,
        assertLedgerEntry, assertSanity } = require('../../setup/assertion-helpers');
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
    // 6. MINT creates supply: verify credits, balances, tokens.supply
    // -----------------------------------------------------------------------
    it('MINT creates credit, updates balance, and increments token supply', async function () {
        await seeder.seedBlock(200, BASE_TIME, [
            { source: ADDR1, data: 'ISSUE|0|MINTME|10000|1000|0|Mintable token' }
        ]);
        await seeder.seedBlock(201, BASE_TIME + 10, [
            { source: ADDR1, data: 'MINT|0|MINTME|500' }
        ]);

        await processBlocks(indexer);

        await assertTokenSupply(indexerQuery, 'MINTME', '500');
        await assertBalance(indexerQuery, ADDR1, 'MINTME', '500');

        // A credit entry should exist for the MINT action
        const mintActionIndex = await getLastActionIndexByType(indexerQuery, 'MINT');
        await assertLedgerEntry(indexerQuery, 'credits', mintActionIndex, 'MINTME', ADDR1, '500');

        await assertActionStatus(indexerQuery, 'mints', mintActionIndex, 'valid');
    });

    // -----------------------------------------------------------------------
    // 7. MINT exceeding MAX_MINT: status invalid
    // -----------------------------------------------------------------------
    it('MINT exceeding MAX_MINT is marked invalid', async function () {
        // MAX_MINT is 100
        await seeder.seedBlock(210, BASE_TIME, [
            { source: ADDR1, data: 'ISSUE|0|CAPTOKEN|5000|100|0|Capped minting' }
        ]);
        // Attempt to mint 101: exceeds MAX_MINT
        await seeder.seedBlock(211, BASE_TIME + 10, [
            { source: ADDR1, data: 'MINT|0|CAPTOKEN|101' }
        ]);

        await processBlocks(indexer);

        const mintActionIndex = await getLastActionIndexByType(indexerQuery, 'MINT');
        await assertActionStatus(indexerQuery, 'mints', mintActionIndex, 'invalid: AMOUNT > MAX_MINT');

        // Supply should remain 0
        await assertTokenSupply(indexerQuery, 'CAPTOKEN', '0');
    });

});

describe('ISSUE / MINT / SEND / DESTROY Token Lifecycle @regression @tier1', function () {
    this.timeout(30000);
    before(createFileSchemas);
    beforeEach(freshChainAndIndexer);
    afterEach(stopIndexer);
    after(closeFileSchemas);

    // -----------------------------------------------------------------------
    // 8. MINT after MAX_SUPPLY reached: status invalid
    // -----------------------------------------------------------------------
    it('MINT that would exceed MAX_SUPPLY is marked invalid', async function () {
        // MAX_SUPPLY=100, MAX_MINT=100
        await seeder.seedBlock(220, BASE_TIME, [
            { source: ADDR1, data: 'ISSUE|0|FULLSUP|100|100|0|Full supply token' }
        ]);
        // Mint the full supply
        await seeder.seedBlock(221, BASE_TIME + 10, [
            { source: ADDR1, data: 'MINT|0|FULLSUP|100' }
        ]);
        // Try to mint 1 more: should fail
        await seeder.seedBlock(222, BASE_TIME + 20, [
            { source: ADDR1, data: 'MINT|0|FULLSUP|1' }
        ]);

        await processBlocks(indexer);

        // Last MINT action should be invalid. Scope to this test's tick:
        // the gas preamble adds XCHAIN mint rows of its own.
        const allMints = await indexerQuery(
            `SELECT m.action_index, s.status
             FROM mints m
             INNER JOIN index_statuses s ON s.id = m.status_id
             INNER JOIN index_tickers  t ON t.id = m.tick_id
             WHERE t.tick = 'FULLSUP'
             ORDER BY m.action_index ASC`
        );
        assert.strictEqual(allMints.length, 2, 'Should have 2 mint records');
        assert.strictEqual(allMints[0].status, 'valid');
        assert.ok(allMints[1].status.startsWith('invalid'),
            'Over-supply mint should be invalid');

        // Supply should remain 100
        await assertTokenSupply(indexerQuery, 'FULLSUP', '100');
    });

});

describe('ISSUE / MINT / SEND / DESTROY Token Lifecycle @regression @tier1', function () {
    this.timeout(30000);
    before(createFileSchemas);
    beforeEach(freshChainAndIndexer);
    afterEach(stopIndexer);
    after(closeFileSchemas);

    // -----------------------------------------------------------------------
    // 16. Token with 8 decimals: amounts stored correctly
    // -----------------------------------------------------------------------
    it('token with 8 decimals stores and retrieves fractional amounts correctly', async function () {
        // MAX_SUPPLY and MAX_MINT with decimal values
        await seeder.seedBlock(700, BASE_TIME, [
            { source: ADDR1, data: 'ISSUE|0|PRECISE|100.00000000|10.00000000|8|8-decimal token' }
        ]);
        await seeder.seedBlock(701, BASE_TIME + 10, [
            { source: ADDR1, data: 'MINT|0|PRECISE|5.00000000' }
        ]);

        await processBlocks(indexer);

        // mathjs bignumber toString() drops trailing zeros in both supply and balance
        await assertTokenSupply(indexerQuery, 'PRECISE', '5');
        await assertBalance(indexerQuery, ADDR1, 'PRECISE', '5');

        // Sanity check
        await assertSanity(indexerQuery, 'PRECISE');
    });

    // -----------------------------------------------------------------------
    // 17. MINT with DESTINATION: credit goes to destination, not source
    // -----------------------------------------------------------------------
    it('MINT with DESTINATION credits the destination address, not source', async function () {
        await seeder.seedBlock(800, BASE_TIME, [
            { source: ADDR1, data: 'ISSUE|0|DESTMINT|5000|1000|0|Destination mint' }
        ]);
        // MINT to ADDR2 as destination
        await seeder.seedBlock(801, BASE_TIME + 10, [
            { source: ADDR1, data: 'MINT|0|DESTMINT|300|' + ADDR2 }
        ]);

        await processBlocks(indexer);

        // ADDR2 should have the minted balance
        await assertBalance(indexerQuery, ADDR2, 'DESTMINT', '300');
        // ADDR1 should have no balance (minted directly to ADDR2)
        await assertBalance(indexerQuery, ADDR1, 'DESTMINT', null);

        // Supply is still 300
        await assertTokenSupply(indexerQuery, 'DESTMINT', '300');
    });

});
