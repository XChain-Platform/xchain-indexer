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
 * Integration tests: ISSUE / MINT / SEND / DESTROY token lifecycle
 *
 * Exercises the core token lifecycle: issuance, minting supply, transferring
 * balances, destroying supply, and related invalid-state rejection paths.
 *
 * The suite spans this file (the ISSUE cases) and the parts in 02_issue_mint_send.test/
 * (mint, send, destroy), all under one describe title, so every full test title reads as
 * it did in one file. Shared actors and hook bodies: 02_issue_mint_send.test/helpers/.
 */

'use strict';

const assert = require('assert');
const { indexerQuery } = require('../setup/db-connection');
const { processBlocks, destroyIndexer } = require('../setup/indexer-launcher');
const { assertTokenSupply, assertTokenOwner, assertActionStatus, getLastActionIndexByType,
        getToken } = require('../setup/assertion-helpers');
const { ADDR1, ADDR2, BASE_TIME, fileSchemaHooks, freshLifecycleChain } = require('./02_issue_mint_send.test/helpers/lifecycle_chain');

// The lifecycle is written as consecutive blocks that all carry the same describe title, so
// no block exceeds the readability limit while every full test title stays what it was. The
// four hooks are the same in every block (each test still runs under all four); their bodies
// live once in 02_issue_mint_send.test/helpers/lifecycle_chain.js, shared with the parts
// beside this file, and the state they build lives here. Repeating them per block is
// equivalent work, not different work: createDatabases drops and recreates this file's own
// scoped schemas, and closeAll only ends pools that the next block's first query reopens.
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
    // 1. ISSUE creates token: verify issues table, tokens table, index_tickers
    // -----------------------------------------------------------------------
    it('ISSUE creates records in issues, tokens, and index_tickers', async function () {
        await seeder.seedBlock(100, BASE_TIME, [
            { source: ADDR1, data: 'ISSUE|0|MYTOKEN|1000|100|0|My first token' }
        ]);

        await processBlocks(indexer);

        // index_tickers should have the tick
        const tickRows = await indexerQuery(
            'SELECT id FROM index_tickers WHERE tick = ?', ['MYTOKEN']
        );
        assert.strictEqual(tickRows.length, 1, 'index_tickers should contain MYTOKEN');

        // tokens table should have a record
        const tokenRows = await indexerQuery(
            `SELECT t.max_supply, t.max_mint, t.decimals
             FROM tokens t
             INNER JOIN index_tickers it ON it.id = t.tick_id
             WHERE it.tick = 'MYTOKEN'`
        );
        assert.strictEqual(tokenRows.length, 1, 'tokens table should have MYTOKEN');

        // issues table should have a valid record
        const actionIndex = await getLastActionIndexByType(indexerQuery, 'ISSUE');
        assert.ok(actionIndex !== null, 'ISSUE action_index should exist');
        await assertActionStatus(indexerQuery, 'issues', actionIndex, 'valid');
    });

});

describe('ISSUE / MINT / SEND / DESTROY Token Lifecycle @regression @tier1', function () {
    this.timeout(30000);
    before(createFileSchemas);
    beforeEach(freshChainAndIndexer);
    afterEach(stopIndexer);
    after(closeFileSchemas);

    // -----------------------------------------------------------------------
    // 2. ISSUE with all fields: MAX_SUPPLY, MAX_MINT, DECIMALS, DESCRIPTION
    // -----------------------------------------------------------------------
    it('ISSUE stores MAX_SUPPLY, MAX_MINT, DECIMALS, DESCRIPTION correctly', async function () {
        // Format 0: VERSION|TICK|MAX_SUPPLY|MAX_MINT|DECIMALS|DESCRIPTION
        await seeder.seedBlock(101, BASE_TIME, [
            { source: ADDR1, data: 'ISSUE|0|FULLTOKEN|999999|5000|8|Full token description' }
        ]);

        await processBlocks(indexer);

        const tokenInfo = await getToken(indexerQuery, 'FULLTOKEN');
        assert.ok(tokenInfo, 'Token FULLTOKEN should exist');
        assert.strictEqual(tokenInfo.max_supply, '999999.00000000', 'MAX_SUPPLY should match');
        assert.strictEqual(tokenInfo.max_mint, '5000.00000000', 'MAX_MINT should match');
        assert.strictEqual(String(tokenInfo.decimals), '8', 'DECIMALS should be 8');
    });

    // -----------------------------------------------------------------------
    // 3. Re-ISSUE by owner updates description (format 1)
    // -----------------------------------------------------------------------
    it('re-ISSUE by owner with format 1 updates description', async function () {
        // Initial ISSUE
        await seeder.seedBlock(110, BASE_TIME, [
            { source: ADDR1, data: 'ISSUE|0|EDITME|1000|100|0|Original description' }
        ]);
        // Update description via format 1: VERSION|TICK|DESCRIPTION|MEMO
        await seeder.seedBlock(111, BASE_TIME + 10, [
            { source: ADDR1, data: 'ISSUE|1|EDITME|Updated description' }
        ]);

        await processBlocks(indexer);

        // Both issues should be valid
        const issueRows = await indexerQuery(
            `SELECT i.description, s.status
             FROM issues i
             INNER JOIN index_statuses s ON s.id = i.status_id
             INNER JOIN index_tickers  t ON t.id = i.tick_id
             WHERE t.tick = 'EDITME'
             ORDER BY i.action_index ASC`
        );
        assert.strictEqual(issueRows.length, 2, 'Should have 2 issue records');
        assert.strictEqual(issueRows[0].status, 'valid');
        assert.strictEqual(issueRows[1].status, 'valid');
        assert.strictEqual(issueRows[1].description, 'Updated description',
            'Description should be updated in second issue');
    });

});

describe('ISSUE / MINT / SEND / DESTROY Token Lifecycle @regression @tier1', function () {
    this.timeout(30000);
    before(createFileSchemas);
    beforeEach(freshChainAndIndexer);
    afterEach(stopIndexer);
    after(closeFileSchemas);

    // -----------------------------------------------------------------------
    // 4. Re-ISSUE by non-owner fails
    // -----------------------------------------------------------------------
    it('re-ISSUE by non-owner address is marked invalid', async function () {
        await seeder.seedBlock(120, BASE_TIME, [
            { source: ADDR1, data: 'ISSUE|0|OWNED|2000|100|0|Token owned by ADDR1' }
        ]);
        // ADDR2 (non-owner) tries to update
        await seeder.seedBlock(121, BASE_TIME + 10, [
            { source: ADDR2, data: 'ISSUE|1|OWNED|Takeover attempt' }
        ]);

        await processBlocks(indexer);

        // First issue valid, second invalid
        const issueRows = await indexerQuery(
            `SELECT s.status
             FROM issues i
             INNER JOIN index_statuses s ON s.id = i.status_id
             INNER JOIN index_tickers  t ON t.id = i.tick_id
             WHERE t.tick = 'OWNED'
             ORDER BY i.action_index ASC`
        );
        assert.strictEqual(issueRows.length, 2);
        assert.strictEqual(issueRows[0].status, 'valid', 'Original ISSUE should be valid');
        assert.ok(issueRows[1].status.startsWith('invalid'),
            'Non-owner re-ISSUE should be invalid');
    });

    // -----------------------------------------------------------------------
    // 5. ISSUE reserved tick name (BTC): status invalid
    // -----------------------------------------------------------------------
    it('ISSUE of reserved tick BTC is rejected on every network, regtest included', async function () {
        await seeder.seedBlock(130, BASE_TIME, [
            { source: ADDR1, data: 'ISSUE|0|BTC|1000|100|0|Trying to issue reserved tick' }
        ]);

        await processBlocks(indexer);

        const actionIndex = await getLastActionIndexByType(indexerQuery, 'ISSUE');
        assert.ok(actionIndex !== null);
        // The regtest exemption is the GAS tick alone: the
        // coin roots BTC, LTC
        // and DOGE are the parents of every origin-rooted bridged copy, the bridge
        // creates each root row itself, and regtest is the only venue the bridge drill
        // runs on, so a squatted root there would break the drill the bridge is
        // proven by. One expectation holds on every network.
        await assertActionStatus(indexerQuery, 'issues', actionIndex, 'invalid: TICK (reserved)');
    });

});

describe('ISSUE / MINT / SEND / DESTROY Token Lifecycle @regression @tier1', function () {
    this.timeout(30000);
    before(createFileSchemas);
    beforeEach(freshChainAndIndexer);
    afterEach(stopIndexer);
    after(closeFileSchemas);

    // -----------------------------------------------------------------------
    // 18. Lock immutability: ISSUE with LOCK_MINT=1, then MINT fails
    // -----------------------------------------------------------------------
    it('ISSUE with LOCK_MINT=1 causes subsequent MINT to be invalid', async function () {
        // Create token with LOCK_MINT=1 using full format 0.
        // MINT_START_BLOCK and MINT_STOP_BLOCK set to 0 (null-like) to avoid
        // the "MINT_STOP_BLOCK < BLOCK_INDEX" validation error.
        // Format 0 fields: VERSION|TICK|MAX_SUPPLY|MAX_MINT|DECIMALS|DESCRIPTION|
        //   MINT_SUPPLY|TRANSFER|TRANSFER_SUPPLY|LOCK_MAX_SUPPLY|LOCK_MAX_MINT|
        //   LOCK_DESCRIPTION|LOCK_SLEEP|LOCK_CALLBACK|CALLBACK_BLOCK|CALLBACK_TICK|
        //   CALLBACK_AMOUNT|ALLOW_LIST|BLOCK_LIST|MINT_ADDRESS_MAX|MINT_START_BLOCK|
        //   MINT_STOP_BLOCK|LOCK_MINT|LOCK_MINT_SUPPLY|MEMO
        // Need 25 fields after ACTION: VERSION(0) through MEMO(24), LOCK_MINT is index 22
        const issueData = 'ISSUE|0|LOCKTOKEN|1000|100|0|Locked token|||||||||||||||||1';

        await seeder.seedBlock(900, BASE_TIME, [
            { source: ADDR1, data: issueData }
        ]);
        // MINT should fail due to LOCK_MINT
        await seeder.seedBlock(901, BASE_TIME + 10, [
            { source: ADDR1, data: 'MINT|0|LOCKTOKEN|50' }
        ]);

        await processBlocks(indexer);

        // MINT should be invalid
        const mintActionIndex = await getLastActionIndexByType(indexerQuery, 'MINT');
        await assertActionStatus(indexerQuery, 'mints', mintActionIndex, 'invalid: LOCK_MINT');

        // Supply should be 0: no MINT_SUPPLY was provided, and MINT is blocked
        await assertTokenSupply(indexerQuery, 'LOCKTOKEN', '0');
    });

    // -----------------------------------------------------------------------
    // 19. ISSUE owner is set from SOURCE address
    // -----------------------------------------------------------------------
    it('ISSUE sets token owner to the source address', async function () {
        await seeder.seedBlock(1000, BASE_TIME, [
            { source: ADDR1, data: 'ISSUE|0|OWNEDBY1|1000|100|0|Owned by addr1' }
        ]);

        await processBlocks(indexer);

        await assertTokenOwner(indexerQuery, 'OWNEDBY1', ADDR1);
    });

});
