/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 * Integration tests: precomputed genesis state dump (genesisDump.js).
 *
 * The dump is a consensus artifact: a full-parse node imports it instead of
 * re-deriving the genesis ledger. These tests assert the safety property that
 * makes that sound - importing a dump yields BYTE-IDENTICAL genesis block hashes
 * to the canonical CSV injection - plus that a content-hash mismatch halts the
 * import. See src/genesisDump.js and scripts/generate-genesis-dump.js.
 */

'use strict';

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const { decoderQuery, indexerQuery, createDatabases, createDecoderSchema,
        resetDecoderDb, resetIndexerDb, closeAll } = require('../setup/db-connection');
const DecoderSeeder = require('../setup/decoder-seeder');
const { initIndexer, processBlocks, destroyIndexer } = require('../setup/indexer-launcher');
const GenesisDump = require('../../../src/genesisDump');

const GENESIS_BLOCK = 100;
const BASE_TIME     = 1700000000;
const LEDGER_PATH   = path.join(__dirname, '../../../data/genesis/ledger-test.csv');
const NO_DUMP       = path.join(os.tmpdir(), 'xchain-genesis-absent-' + GENESIS_BLOCK + '.gz'); // never created
const DUMP_FILE     = path.join(os.tmpdir(), 'xchain-genesis-dump-test-' + GENESIS_BLOCK + '.ndjson.gz');

async function ownerMap() {
    const rows = await indexerQuery(
        `SELECT it.tick AS tick, ia.address AS owner
         FROM tokens t
         INNER JOIN index_tickers it ON it.id = t.tick_id
         INNER JOIN index_addresses ia ON ia.id = t.owner_id`);
    const m = {};
    for (const r of rows) m[r.tick] = r.owner;
    return m;
}

describe('Genesis Dump Import @regression', function () {
    // Three cold indexer inits (verifyTables builds ~60 tables each) put the
    // byte-identity case at ~125s on a real DB, past the old 120s ceiling.
    this.timeout(600000);

    before(async function () {
        process.env.XCHAIN_GENESIS_BLOCK = String(GENESIS_BLOCK);
        process.env.GENESIS_LEDGER_PATH  = LEDGER_PATH;
        await createDatabases();
        await createDecoderSchema();
    });

    after(async function () {
        delete process.env.XCHAIN_GENESIS_BLOCK;
        delete process.env.GENESIS_LEDGER_PATH;
        delete process.env.GENESIS_DUMP_PATH;
        delete process.env.XCHAIN_GENESIS_DUMP_HASH;
        try { fs.unlinkSync(DUMP_FILE); } catch (e) { /* ignore */ }
        await closeAll();
    });

    it('imports a precomputed dump to byte-identical genesis block hashes (and owners)', async function () {
        // --- Step A: canonical CSV injection ---
        process.env.GENESIS_DUMP_PATH = NO_DUMP; // force the CSV path
        await resetDecoderDb();
        await resetIndexerDb();
        let seeder = new DecoderSeeder(decoderQuery);
        await seeder.seedBlock(GENESIS_BLOCK, BASE_TIME, []);
        let idx = await initIndexer();
        await processBlocks(idx);
        const hCsv     = await idx.indexerDb.getBlockHashes(GENESIS_BLOCK);
        const ownersCsv = await ownerMap();
        await destroyIndexer(idx);

        // --- Step B: generate a dump (mirror the generator: inject, dump pre-createBlock, roll back) ---
        await resetIndexerDb();
        idx = await initIndexer();
        idx.config['GENESIS_DUMP_PATH'] = null; // ensure CSV derivation during generation
        await idx.indexerDb.beginTransaction();
        idx.indexerDb.blockIndex = GENESIS_BLOCK;
        await idx.genesis.inject(GENESIS_BLOCK, BASE_TIME);
        const dump = new GenesisDump(idx.indexerDb, idx.util, idx.config);
        const meta = await dump.write(DUMP_FILE);
        await idx.indexerDb.rollbackTransaction();
        await destroyIndexer(idx);
        assert.ok(fs.existsSync(DUMP_FILE), 'dump file written');

        // --- Step C: fresh DB, import the dump via the normal block flow, compare ---
        process.env.GENESIS_DUMP_PATH       = DUMP_FILE;
        process.env.XCHAIN_GENESIS_DUMP_HASH = meta.contentHash; // pin it
        await resetIndexerDb();
        idx = await initIndexer();
        await processBlocks(idx); // inject() takes the import fast-path + self-verifies
        const hImp     = await idx.indexerDb.getBlockHashes(GENESIS_BLOCK);
        const ownersImp = await ownerMap();
        await destroyIndexer(idx);

        assert.strictEqual(hImp.ledger.hash,    hCsv.ledger.hash,    'ledger hash identical');
        assert.strictEqual(hImp.actions.hash,   hCsv.actions.hash,   'actions hash identical');
        assert.strictEqual(hImp.state.hash,     hCsv.state.hash,     'state hash identical');
        assert.strictEqual(hImp.contracts.hash, hCsv.contracts.hash, 'contracts hash identical');
        assert.deepStrictEqual(ownersImp, ownersCsv, 'token ownership identical');
        assert.ok(Object.keys(ownersImp).length > 0, 'sanity: tokens were created');
    });

    it('refuses a dump whose content hash does not match the pin', async function () {
        assert.ok(fs.existsSync(DUMP_FILE), 'reuses the dump from the previous test');
        process.env.GENESIS_DUMP_PATH        = DUMP_FILE;
        process.env.XCHAIN_GENESIS_DUMP_HASH = 'deadbeef'.repeat(8); // wrong pin
        await resetIndexerDb();
        const idx = await initIndexer();
        await assert.rejects(() => processBlocks(idx), /hash mismatch/, 'tampered/mispinned dump must halt');
        await destroyIndexer(idx);
    });
});
