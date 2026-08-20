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
 * Integration test: the reader-side per-output fan-out collapse.
 *
 * getDecoderBlockData LEFT JOINs transaction_outputs and emits ONE row per stored
 * native-coin output, all carrying the same action data. Production collapses that
 * fan-out for data-bearing non-COINPAY transactions (XChainIndexer.start ->
 * output_fanout.collapseOutputFanout) so the action executes exactly once.
 *
 * This file exists to keep the integration HARNESS honest about that, not to test
 * output_fanout.js itself (test/unit/output_fanout.test.js does that). The launcher
 * used to omit the collapse, so every scenario in this tier silently modelled a
 * multi-output data-bearing transaction as executing once PER OUTPUT - a harness
 * that disagrees with the fleet about how many times a transaction runs, and one
 * that would certify a doubled ledger effect as correct. If the launcher loses the
 * collapse again, the SEND below credits its destination twice and this reddens.
 *
 * Requires the multi-output `outputs` shape in decoder-seeder.js: the single-output
 * shape cannot express a transaction that pays two addresses, which is why no
 * earlier scenario could reach this code path at all.
 */

'use strict';

const assert = require('assert');
const { decoderQuery, indexerQuery, createDatabases, createDecoderSchema,
        resetDecoderDb, resetIndexerDb, closeAll } = require('../setup/db-connection');
const DecoderSeeder = require('../setup/decoder-seeder');
const { initIndexer, processBlocks, destroyIndexer, destroyFileIndexers } = require('../setup/indexer-launcher');
const { assertBalance, countRows } = require('../setup/assertion-helpers');
const { seedGas } = require('../setup/gas-seeder');

const ADDR1 = 'msK1rsgNVFPM4cR3X5rngczTKa6EtT4WKD'; // issuer / sender
const ADDR2 = 'mjifPngDYQ6HHPNQdGk1kQuFkJWEiQksQp'; // SEND destination, also paid natively
const ADDR3 = 'mwGujTXFXMLN2YXqo4mQK4DcKy31DUcwoi'; // second native payee

const TICK = 'FANOUT';
const T0   = 1700000000;

describe('28 output fan-out collapse: a multi-output data-bearing tx runs ONCE @regression @tier2', function () {
    this.timeout(60000);

    let indexer;

    before(async function () {
        await createDatabases(__filename);
        await createDecoderSchema();
        await resetDecoderDb();
        await resetIndexerDb();

        const seeder = new DecoderSeeder(decoderQuery);
        indexer = await initIndexer();
        await seedGas(seeder, { addresses: [ADDR1, ADDR2, ADDR3] });

        await seeder.seedBlock(100, T0, [
            { source: ADDR1, data: 'ISSUE|0|' + TICK + '|1000|1000|0' },
        ]);
        await seeder.seedBlock(101, T0 + 600, [
            { source: ADDR1, data: 'MINT|0|' + TICK + '|1000' },
        ]);
        // The witness. One SEND of 200 to ADDR2, in a transaction that pays TWO
        // addresses natively - the shape a real fee-destination-plus-dispenser (or
        // two-oracle) transaction has on the wire. Production executes this ONE
        // action once; the un-collapsed harness executed it once per output row.
        await seeder.seedBlock(102, T0 + 1200, [
            { source: ADDR1,
              data: 'SEND|0|' + TICK + '|200|' + ADDR2 + '|',
              outputs: [
                  { destination: ADDR2, amount: '0.00010000', vout: 0 },
                  { destination: ADDR3, amount: '0.00020000', vout: 1 },
              ] },
        ]);

        await processBlocks(indexer);
    });

    after(async function () {
        await destroyIndexer(indexer);
        await destroyFileIndexers(__filename);
        await closeAll();
    });

    it('the two-output transaction really did fan out to two decoder rows', async function () {
        // Guards the guard: if the seeder stopped emitting two outputs this file would
        // pass for the wrong reason, proving nothing about the collapse.
        const rows = await decoderQuery(
            `SELECT o.vout FROM transaction_outputs o
             INNER JOIN transactions t ON t.tx_index = o.tx_index
             WHERE t.block_index = 102 ORDER BY o.vout`
        );
        assert.strictEqual(rows.length, 2, 'block 102 tx should have two stored outputs');
    });

    it('records exactly ONE send, not one per output', async function () {
        const cnt = await countRows(indexerQuery, 'sends');
        assert.strictEqual(Number(cnt), 1,
            'a single SEND transaction paying two addresses must produce one send row');
    });

    it('credits the destination once (no doubled ledger effect)', async function () {
        await assertBalance(indexerQuery, ADDR2, TICK, '200');
        await assertBalance(indexerQuery, ADDR1, TICK, '800');
    });

    it('indexes the action once', async function () {
        const rows = await indexerQuery(
            `SELECT COUNT(*) AS c FROM actions WHERE block_index = 102`
        );
        assert.strictEqual(Number(rows[0].c), 1,
            'one on-chain transaction is one action, whatever its output count');
    });
});
