'use strict';
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
 *
 * Generate a precomputed genesis state dump (genesisDump.js artifact).
 *
 * Runs the canonical CSV genesis injection ONCE against a scratch DB, then writes
 * the post-injection rows (pre-createBlock) to a gzip NDJSON file and prints the
 * sha256 of its UNCOMPRESSED content to pin as GENESIS_DUMP_HASH. A full-parse node
 * then imports this file in minutes instead of re-deriving the ledger for ~1h.
 *
 * Usage (Node 22, MariaDB reachable):
 *   INDEXER_COIN=BTC INDEXER_NETWORK=regtest \
 *     XCHAIN_GENESIS_BLOCK=100 GENESIS_LEDGER_PATH=data/genesis/BTC-ledger.csv \
 *     node scripts/generate-genesis-dump.js data/genesis/BTC-genesis-dump.ndjson.gz
 *
 * Uses the integration test harness for DB wiring (scratch xchain_test_* DBs), so it
 * never touches a live indexer DB. The dump itself is environment-independent.
 *
 ********************************************************************/

const path = require('path');
const SETUP = path.join(__dirname, '..', 'test', 'integration', 'setup');
const { decoderQuery, createDatabases, createDecoderSchema,
        resetDecoderDb, resetIndexerDb, closeAll } = require(path.join(SETUP, 'db-connection'));
const DecoderSeeder = require(path.join(SETUP, 'decoder-seeder'));
const { initIndexer, destroyIndexer } = require(path.join(SETUP, 'indexer-launcher'));
const GenesisDump = require(path.join(__dirname, '..', 'src', 'genesisDump'));

const outFile = process.argv[2];
if(!outFile){
    console.error('usage: node scripts/generate-genesis-dump.js <out-file.ndjson.gz>');
    process.exit(2);
}

(async () => {
    const GENESIS_BLOCK = Number(process.env.XCHAIN_GENESIS_BLOCK || '100');
    await createDatabases();
    await createDecoderSchema();
    await resetDecoderDb();
    await resetIndexerDb();

    // Seed an empty block at the genesis height (the injector runs before the real-tx loop).
    const seeder = new DecoderSeeder(decoderQuery);
    await seeder.seedBlock(GENESIS_BLOCK, 1700000000, []);

    const indexer = await initIndexer();
    if(Number(indexer.config['GENESIS_BLOCK']) !== GENESIS_BLOCK){
        console.error('GENESIS_BLOCK config (' + indexer.config['GENESIS_BLOCK'] + ') != ' + GENESIS_BLOCK + '; set XCHAIN_GENESIS_BLOCK.');
        process.exit(1);
    }
    // Make sure we take the CSV derivation, not an existing dump.
    indexer.config['GENESIS_DUMP_PATH'] = null;

    // Manually drive ONLY the injection inside a transaction, then dump BEFORE createBlock
    // so the artifact is pure inject output (no block-hash rows). Roll back afterward; the
    // dump file is the deliverable, not the scratch DB state.
    await indexer.indexerDb.beginTransaction();
    indexer.indexerDb.blockIndex = GENESIS_BLOCK;
    const t0 = process.hrtime.bigint();
    await indexer.genesis.inject(GENESIS_BLOCK, 1700000000);
    const injectSec = Number(process.hrtime.bigint() - t0) / 1e9;

    const dump = new GenesisDump(indexer.indexerDb, indexer.util, indexer.config);
    const res = await dump.write(outFile);
    await indexer.indexerDb.rollbackTransaction();

    const totalRows = Object.values(res.rowCounts).reduce((s, n) => s + n, 0);
    console.log('\n=== genesis dump written ===');
    console.log('coin:           ' + indexer.config['COIN']);
    console.log('genesis block:  ' + GENESIS_BLOCK);
    console.log('inject time:    ' + injectSec.toFixed(1) + 's');
    console.log('file:           ' + outFile);
    console.log('tables/rows:    ' + Object.keys(res.rowCounts).length + ' tables, ' + totalRows + ' rows');
    console.log('block hashes:   ledger=' + res.expectedHashes.ledger + ' actions=' + res.expectedHashes.actions);
    console.log('CONTENT SHA256: ' + res.contentHash + '   <-- pin as GENESIS_DUMP_HASH');

    await destroyIndexer(indexer);
    await closeAll();
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
