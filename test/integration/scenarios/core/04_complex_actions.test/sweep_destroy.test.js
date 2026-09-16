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
 * test/integration/scenarios/core/04_complex_actions.test/sweep_destroy.test.js
 *
 * The SWEEP and DESTROY cases of the complex-actions suite: a sweep of every balance to
 * another address, and a burn that lowers supply with no matching credit.
 *
 * Kept under the entry file's describe title, so every full test title reads as it did
 * when the suite was one file (04_complex_actions.test.js holds the BATCH and SLEEP cases).
 * The actors and chain helpers are in helpers/complex_chain.js. Needs a disposable MariaDB,
 * like every scenario here.
 */

'use strict';

const assert = require('assert');
const { indexerQuery } = require('../../../setup/db-connection');
const { processBlocks, destroyIndexer } = require('../../../setup/indexer-launcher');
const helpers = require('../../../setup/assertion-helpers');
const { ADDR1, ADDR2, TICK_X, T0, freshIndexer, seedGasToken, fileSchemaHooks } = require('./helpers/complex_chain');

// This file's own scoped schemas, claimed in each block's before/after. The entry file
// claims its schemas in root hooks instead; a root hook here would run before every file of
// a whole-directory run rather than before these blocks.
const { createFileSchemas, closeFileSchemas } = fileSchemaHooks(__filename);

// The chain the "SWEEP format 0 – sweep all balances to ADDR2" tests read: seeded and processed once, exactly as that
// block's own before hook did before the body moved here.
async function seedSWEEPFormat0SweepAll() {
    const { seeder, indexer } = await freshIndexer();

    // Seed XCHAIN gas token and send to ADDR1
    await seedGasToken(seeder, ADDR1, '100');

    await seeder.seedBlock(100, T0, [
        { source: ADDR1, destination: null, amount: '0',
          data: 'ISSUE|0|' + TICK_X + '|1000|100|0' },
    ]);
    await seeder.seedBlock(101, T0 + 600, [
        { source: ADDR1, destination: null, amount: '0',
          data: 'MINT|0|' + TICK_X + '|80' },
    ]);
    // Block 102 – SWEEP all balances from ADDR1 to ADDR2 (no ownerships, no escrows)
    // FORMAT: SWEEP|0|DESTINATION|BALANCES|OWNERSHIPS|ESCROWS|MEMO
    await seeder.seedBlock(102, T0 + 1200, [
        { source: ADDR1, destination: null, amount: '0',
          data: 'SWEEP|0|' + ADDR2 + '|1|0|0|' },
    ]);

    await processBlocks(indexer);

    return indexer;
}

// The chain the "DESTROY format 0 – burn tokens" tests read: seeded and processed once, exactly as that
// block's own before hook did before the body moved here.
async function seedDESTROYFormat0BurnTokens() {
    const { seeder, indexer } = await freshIndexer();

    // Fee era: the ISSUE below needs gas (file convention: seedGasToken)
    await seedGasToken(seeder, ADDR1, '100');

    await seeder.seedBlock(100, T0, [
        { source: ADDR1, destination: null, amount: '0',
          data: 'ISSUE|0|' + TICK_X + '|1000|100|0' },
    ]);
    await seeder.seedBlock(101, T0 + 600, [
        { source: ADDR1, destination: null, amount: '0',
          data: 'MINT|0|' + TICK_X + '|100' },
    ]);
    // Block 102 – destroy 20 XTOKEN
    await seeder.seedBlock(102, T0 + 1200, [
        { source: ADDR1, destination: null, amount: '0',
          data: 'DESTROY|0|' + TICK_X + '|20|burning tokens' },
    ]);

    await processBlocks(indexer);

    return indexer;
}

describe('04 complex actions – BATCH, SLEEP, SWEEP, DESTROY, LIST, AIRDROP @regression @tier2', function () {
    this.timeout(60000);
    before(createFileSchemas);
    after(closeFileSchemas);

    // -----------------------------------------------------------------------
    // 5. SWEEP balances to new address: all tokens moved
    // -----------------------------------------------------------------------
    describe('SWEEP format 0 – sweep all balances to ADDR2', function () {
        let indexer;

        before(async function () { indexer = await seedSWEEPFormat0SweepAll(); });

        after(async function () { await destroyIndexer(indexer); });

        it('should create a SWEEP record', async function () {
            const cnt = await helpers.countRows(indexerQuery, 'sweeps');
            assert.ok(cnt >= 1, 'Should have at least 1 sweep record');
        });

        it('ADDR1 should have 0 XTOKEN after sweep', async function () {
            await helpers.assertBalance(indexerQuery, ADDR1, TICK_X, null);
        });

        it('ADDR2 should have received all XTOKEN from the sweep', async function () {
            const rows = await indexerQuery(
                `SELECT b.amount FROM balances b
                 INNER JOIN index_addresses a ON a.id = b.address_id
                 INNER JOIN index_tickers   t ON t.id = b.tick_id
                 WHERE a.address = ? AND t.tick = ?`,
                [ADDR2, TICK_X]
            );
            assert.ok(rows.length > 0, 'ADDR2 should have XTOKEN after sweep');
            assert.ok(parseFloat(rows[0].amount) > 0, 'ADDR2 XTOKEN balance should be > 0');
        });
    });

});

describe('04 complex actions – BATCH, SLEEP, SWEEP, DESTROY, LIST, AIRDROP @regression @tier2', function () {
    this.timeout(60000);
    before(createFileSchemas);
    after(closeFileSchemas);

    // -----------------------------------------------------------------------
    // 6. DESTROY reduces supply with no credit counterpart
    // -----------------------------------------------------------------------
    describe('DESTROY format 0 – burn tokens', function () {
        let indexer;

        before(async function () { indexer = await seedDESTROYFormat0BurnTokens(); });

        after(async function () { await destroyIndexer(indexer); });

        it('should create a DESTROY record', async function () {
            const cnt = await helpers.countRows(indexerQuery, 'destroys');
            assert.ok(cnt >= 1, 'Should have at least 1 destroy record');
        });

        it('ADDR1 balance should be reduced by destroyed amount', async function () {
            await helpers.assertBalance(indexerQuery, ADDR1, TICK_X, '80');
        });

        it('token supply should decrease by destroyed amount', async function () {
            await helpers.assertTokenSupply(indexerQuery, TICK_X, '80');
        });

        it('DESTROY should not create a matching credit entry', async function () {
            // Debits should exist, but there should be no credit for the burn address
            const debitRows = await indexerQuery(
                `SELECT d.amount FROM debits d
                 INNER JOIN index_tickers t ON t.id = d.tick_id
                 WHERE t.tick = ?`,
                [TICK_X]
            );
            assert.ok(debitRows.length > 0, 'Should have at least one debit for XTOKEN');

            // Credits for XTOKEN should only be from MINT (80 total credits), not from DESTROY
            const creditRows = await indexerQuery(
                `SELECT SUM(CAST(c.amount AS DECIMAL(65,18))) AS total FROM credits c
                 INNER JOIN index_tickers t ON t.id = c.tick_id
                 WHERE t.tick = ?`,
                [TICK_X]
            );
            assert.ok(creditRows.length > 0 && creditRows[0].total !== null, 'Credits should exist');
            // Total credits = 100 (from MINT only), not inflated by destroy
            assert.strictEqual(parseFloat(creditRows[0].total), 100,
                'Credits should only reflect MINT, not DESTROY');
        });

        it('sanity check: supply equals balances', async function () {
            await helpers.assertSanity(indexerQuery, TICK_X);
        });
    });

});
