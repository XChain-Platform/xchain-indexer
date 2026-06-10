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
 * Integration tests: whole-ledger state invariants (Phase 1b)
 *
 * Drives a real ISSUE → MINT → SEND → SEND lifecycle through the actual indexer,
 * then asserts the conservation / non-negativity invariants hold over the
 * resulting DB state — and, critically, that the checker is NOT vacuous: it
 * must FAIL on a deliberately corrupted ledger.
 *
 * Exercises the full decoder→indexer pipeline (relies on the createDecoderSchema
 * raw_data/fee/pubkeys columns so actions actually process).
 */

'use strict';

const assert = require('assert');
const { decoderQuery, indexerQuery, createDatabases, createDecoderSchema,
        resetDecoderDb, resetIndexerDb, closeAll } = require('../setup/db-connection');
const DecoderSeeder = require('../setup/decoder-seeder');
const { initIndexer, processBlocks, destroyIndexer } = require('../setup/indexer-launcher');
const { assertStateInvariants } = require('../setup/state-invariants');

const ADDR1 = 'msK1rsgNVFPM4cR3X5rngczTKa6EtT4WKD';
const ADDR2 = 'mjifPngDYQ6HHPNQdGk1kQuFkJWEiQksQp';
const ADDR3 = 'mwGujTXFXMLN2YXqo4mQK4DcKy31DUcwoi';
const BASE_TIME = 1700000000;

// ISSUE → MINT 1000 → SEND 300 (1→2) → SEND 100 (2→3). Final balances
// 700/200/100 sum to the minted 1000, so the ledger must conserve.
async function seedLifecycle(seeder, indexer) {
    await seeder.seedBlock(300, BASE_TIME, [
        { source: ADDR1, data: 'ISSUE|0|INVTEST|1000000|1000000|0|invariant test token' }
    ]);
    await seeder.seedBlock(301, BASE_TIME + 10, [
        { source: ADDR1, data: 'MINT|0|INVTEST|1000' }
    ]);
    await seeder.seedBlock(302, BASE_TIME + 20, [
        { source: ADDR1, data: 'SEND|0|INVTEST|300|' + ADDR2 + '|to addr2' }
    ]);
    await seeder.seedBlock(303, BASE_TIME + 30, [
        { source: ADDR2, data: 'SEND|0|INVTEST|100|' + ADDR3 + '|to addr3' }
    ]);
    await processBlocks(indexer);
}

describe('Whole-ledger state invariants @regression @tier3', function () {
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

    it('a real ISSUE→MINT→SEND lifecycle satisfies every ledger invariant', async function () {
        await seedLifecycle(seeder, indexer);
        const { ticksChecked } = await assertStateInvariants(indexerQuery);
        assert.ok(ticksChecked >= 1, 'expected the issued tick to be checked');

        // sanity: the minted supply really is split across the three holders
        const bal = await indexerQuery(
            `SELECT COALESCE(SUM(CAST(b.amount AS DECIMAL(65,18))), 0) AS total
             FROM balances b INNER JOIN index_tickers it ON it.id = b.tick_id
             WHERE it.tick = 'INVTEST'`
        );
        assert.strictEqual(parseFloat(bal[0].total), 1000, 'balances should sum to the minted supply');
    });

    it('the checker DETECTS a conservation break (inflated balance)', async function () {
        await seedLifecycle(seeder, indexer);
        await assertStateInvariants(indexerQuery);   // clean first

        await indexerQuery(
            `UPDATE balances SET amount = CAST(amount AS DECIMAL(65,18)) + 500
             WHERE tick_id = (SELECT id FROM index_tickers WHERE tick = 'INVTEST') LIMIT 1`
        );
        await assert.rejects(
            () => assertStateInvariants(indexerQuery),
            /INVARIANT\[conservation/,
            'checker missed an inflated balance'
        );
    });

    it('the checker DETECTS a negative balance', async function () {
        await seedLifecycle(seeder, indexer);

        await indexerQuery(
            `UPDATE balances SET amount = '-1'
             WHERE tick_id = (SELECT id FROM index_tickers WHERE tick = 'INVTEST') LIMIT 1`
        );
        await assert.rejects(
            () => assertStateInvariants(indexerQuery),
            /INVARIANT\[(no-negative-balance|conservation)/,
            'checker missed a negative balance'
        );
    });
});
