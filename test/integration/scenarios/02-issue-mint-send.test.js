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
 * Integration tests: ISSUE / MINT / SEND / DESTROY token lifecycle
 *
 * Exercises the core token lifecycle: issuance, minting supply, transferring
 * balances, destroying supply, and related invalid-state rejection paths.
 */

'use strict';

const assert = require('assert');
const { decoderQuery, indexerQuery, createDatabases, createDecoderSchema,
        resetDecoderDb, resetIndexerDb, closeAll } = require('../setup/db-connection');
const DecoderSeeder = require('../setup/decoder-seeder');
const { initIndexer, processBlocks, destroyIndexer } = require('../setup/indexer-launcher');
const { assertBalance, assertTokenSupply, assertTokenOwner,
        assertActionStatus, getActionIndex, getLastActionIndexByType,
        countRows, assertBlockCount, assertLedgerEntry,
        assertSanity, getToken } = require('../setup/assertion-helpers');

// ---------------------------------------------------------------------------
// Test addresses — valid regtest P2PKH (isCryptoAddress validates base58check)
// ---------------------------------------------------------------------------
const ADDR1 = 'msK1rsgNVFPM4cR3X5rngczTKa6EtT4WKD'; // 30 chars — primary issuer
const ADDR2 = 'mjifPngDYQ6HHPNQdGk1kQuFkJWEiQksQp'; // 30 chars — secondary actor
const ADDR3 = 'mwGujTXFXMLN2YXqo4mQK4DcKy31DUcwoi'; // 30 chars — recipient

// Block time baseline
const BASE_TIME = 1700000000;

describe('ISSUE / MINT / SEND / DESTROY Token Lifecycle @regression @tier1', function () {
    this.timeout(30000);

    let seeder, indexer;

    before(async function () {
        await createDatabases();
        await createDecoderSchema();
    });

    beforeEach(async function () {
        await resetDecoderDb();
        await resetIndexerDb();
        seeder = new DecoderSeeder(decoderQuery);
        indexer = await initIndexer();
    });

    afterEach(async function () {
        await destroyIndexer(indexer);
    });

    after(async function () {
        await closeAll();
    });

    // -----------------------------------------------------------------------
    // 1. ISSUE creates token — verify issues table, tokens table, index_tickers
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

    // -----------------------------------------------------------------------
    // 2. ISSUE with all fields — MAX_SUPPLY, MAX_MINT, DECIMALS, DESCRIPTION
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
    // 5. ISSUE reserved tick name (BTC) — status invalid
    // -----------------------------------------------------------------------
    it('ISSUE of reserved tick BTC is rejected (except on regtest, which is exempt)', async function () {
        await seeder.seedBlock(130, BASE_TIME, [
            { source: ADDR1, data: 'ISSUE|0|BTC|1000|100|0|Trying to issue reserved tick' }
        ]);

        await processBlocks(indexer);

        const actionIndex = await getLastActionIndexByType(indexerQuery, 'ISSUE');
        assert.ok(actionIndex !== null);
        // Reserved-tick enforcement (issue.js) is intentionally exempted on
        // regtest so dev/test chains can issue freely; it applies on
        // mainnet/testnet. Assert whichever behavior matches this run's network.
        const expected = (process.env.INDEXER_NETWORK === 'regtest')
            ? 'valid'
            : 'invalid: TICK (reserved)';
        await assertActionStatus(indexerQuery, 'issues', actionIndex, expected);
    });

    // -----------------------------------------------------------------------
    // 6. MINT creates supply — verify credits, balances, tokens.supply
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
    // 7. MINT exceeding MAX_MINT — status invalid
    // -----------------------------------------------------------------------
    it('MINT exceeding MAX_MINT is marked invalid', async function () {
        // MAX_MINT is 100
        await seeder.seedBlock(210, BASE_TIME, [
            { source: ADDR1, data: 'ISSUE|0|CAPTOKEN|5000|100|0|Capped minting' }
        ]);
        // Attempt to mint 101 — exceeds MAX_MINT
        await seeder.seedBlock(211, BASE_TIME + 10, [
            { source: ADDR1, data: 'MINT|0|CAPTOKEN|101' }
        ]);

        await processBlocks(indexer);

        const mintActionIndex = await getLastActionIndexByType(indexerQuery, 'MINT');
        await assertActionStatus(indexerQuery, 'mints', mintActionIndex, 'invalid: AMOUNT > MAX_MINT');

        // Supply should remain 0
        await assertTokenSupply(indexerQuery, 'CAPTOKEN', '0');
    });

    // -----------------------------------------------------------------------
    // 8. MINT after MAX_SUPPLY reached — status invalid
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
        // Try to mint 1 more — should fail
        await seeder.seedBlock(222, BASE_TIME + 20, [
            { source: ADDR1, data: 'MINT|0|FULLSUP|1' }
        ]);

        await processBlocks(indexer);

        // Last MINT action should be invalid
        const allMints = await indexerQuery(
            `SELECT m.action_index, s.status
             FROM mints m
             INNER JOIN index_statuses s ON s.id = m.status_id
             ORDER BY m.action_index ASC`
        );
        assert.strictEqual(allMints.length, 2, 'Should have 2 mint records');
        assert.strictEqual(allMints[0].status, 'valid');
        assert.ok(allMints[1].status.startsWith('invalid'),
            'Over-supply mint should be invalid');

        // Supply should remain 100
        await assertTokenSupply(indexerQuery, 'FULLSUP', '100');
    });

    // -----------------------------------------------------------------------
    // 9. SEND transfers balance — credits, debits, balances for both addresses
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

    // -----------------------------------------------------------------------
    // 10. SEND insufficient balance — status invalid, no ledger changes
    // -----------------------------------------------------------------------
    it('SEND with insufficient balance is marked invalid and creates no ledger entries', async function () {
        await seeder.seedBlock(310, BASE_TIME, [
            { source: ADDR1, data: 'ISSUE|0|SCARCE|100|50|0|Scarce token' }
        ]);
        await seeder.seedBlock(311, BASE_TIME + 10, [
            { source: ADDR1, data: 'MINT|0|SCARCE|50' }
        ]);
        // Try to send 100 — ADDR1 only has 50
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

    // -----------------------------------------------------------------------
    // 11. SEND to invalid address — status invalid
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

    // -----------------------------------------------------------------------
    // 13. DESTROY reduces supply — only debits created, supply decremented
    // -----------------------------------------------------------------------
    it('DESTROY creates a debit record and decrements token supply', async function () {
        await seeder.seedBlock(500, BASE_TIME, [
            { source: ADDR1, data: 'ISSUE|0|BURNABLE|5000|1000|0|Burnable token' }
        ]);
        await seeder.seedBlock(501, BASE_TIME + 10, [
            { source: ADDR1, data: 'MINT|0|BURNABLE|500' }
        ]);
        // DESTROY format 0: VERSION|TICK|AMOUNT|MEMO
        await seeder.seedBlock(502, BASE_TIME + 20, [
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

    // -----------------------------------------------------------------------
    // 14. DESTROY insufficient balance — invalid
    // -----------------------------------------------------------------------
    it('DESTROY with insufficient balance is marked invalid', async function () {
        await seeder.seedBlock(510, BASE_TIME, [
            { source: ADDR1, data: 'ISSUE|0|UNBURNABLE|1000|200|0|Token' }
        ]);
        await seeder.seedBlock(511, BASE_TIME + 10, [
            { source: ADDR1, data: 'MINT|0|UNBURNABLE|100' }
        ]);
        // Try to destroy 500 — only has 100
        await seeder.seedBlock(512, BASE_TIME + 20, [
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
        await seeder.seedBlock(600, BASE_TIME, [
            { source: ADDR1, data: 'ISSUE|0|SANITY|10000|1000|0|Sanity token' }
        ]);
        await seeder.seedBlock(601, BASE_TIME + 10, [
            { source: ADDR1, data: 'MINT|0|SANITY|800' }
        ]);
        await seeder.seedBlock(602, BASE_TIME + 20, [
            { source: ADDR1, destination: ADDR2, data: 'SEND|0|SANITY|300|' + ADDR2 }
        ]);

        await processBlocks(indexer);

        await assertSanity(indexerQuery, 'SANITY');
    });

    // -----------------------------------------------------------------------
    // 16. Token with 8 decimals — amounts stored correctly
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
    // 17. MINT with DESTINATION — credit goes to destination, not source
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

    // -----------------------------------------------------------------------
    // 18. Lock immutability — ISSUE with LOCK_MINT=1, then MINT fails
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

        // Supply should be 0 — no MINT_SUPPLY was provided, and MINT is blocked
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

    // -----------------------------------------------------------------------
    // 20. Multiple tokens coexist independently — balances do not cross
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
