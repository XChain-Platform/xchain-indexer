'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// Perf scenario: full-scale genesis ledger bootstrap. Bundles the real
// production manifest (data/genesis/<COIN>-ledger.csv: ~121.7k BTC ticks,
// ~42.7k DOGE), pins genesis to a regtest block, and measures how long the
// single genesis block takes to inject. Correctness + determinism are already
// proven by integration scenario 22; this validates only that the ~240k-action
// genesis block completes inside GENESIS_BLOCK_TIMEOUT_MS (30 min). Coin is
// chosen by INDEXER_COIN; run once per chain (BTC, then DOGE).

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const { decoderQuery, indexerQuery, createDatabases, createDecoderSchema,
        resetDecoderDb, resetIndexerDb, closeAll } = require('../../integration/setup/db-connection');
const DecoderSeeder = require('../../integration/setup/decoder-seeder');
const { initIndexer, processBlocks, destroyIndexer } = require('../../integration/setup/indexer-launcher');
const { countRows } = require('../../integration/setup/assertion-helpers');

const COIN          = process.env.INDEXER_COIN;
const GENESIS_BLOCK = 100;
const BASE_TIME     = 1700000000;
const LEDGER_PATH   = path.join(__dirname, '../../../data/genesis', COIN + '-ledger.csv');

// Count manifest data rows (every non-empty, non-header line) the way genesis.js
// does, so the assertion tracks the bundled file rather than a hardcoded number.
function manifestRowCount(file) {
    let n = 0;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        if (line === '' || line === 'tick,owner_address') continue;
        n++;
    }
    return n;
}

describe('06 Genesis Bootstrap (full-scale)', function () {
    this.timeout(0); // run under `npm run test:perf` (mocha --timeout 0)

    let seeder, indexer, rowCount, timeoutMs;

    before(async function () {
        assert.ok(fs.existsSync(LEDGER_PATH),
            'bundled manifest missing: ' + LEDGER_PATH + ' (copy from snapshot/<source>/ledger.csv)');
        rowCount = manifestRowCount(LEDGER_PATH);

        // Pin genesis to a current regtest block + the full production manifest.
        // Config (regtest branch) reads these at initIndexer time.
        process.env.XCHAIN_GENESIS_BLOCK = String(GENESIS_BLOCK);
        process.env.GENESIS_LEDGER_PATH  = LEDGER_PATH;

        await createDatabases();
        await createDecoderSchema();
        await resetDecoderDb();
        await resetIndexerDb();

        seeder = new DecoderSeeder(decoderQuery);
        // One empty block at the genesis height: the injector runs before the
        // (here empty) real-transaction loop, so the whole block is genesis work.
        await seeder.seedBlock(GENESIS_BLOCK, BASE_TIME, []);
        indexer = await initIndexer();
        timeoutMs = indexer.config['GENESIS_BLOCK_TIMEOUT_MS'];
    });

    after(async function () {
        delete process.env.XCHAIN_GENESIS_BLOCK;
        delete process.env.GENESIS_LEDGER_PATH;
        await destroyIndexer(indexer);
        await closeAll();
    });

    it('injects the full manifest within the genesis watchdog window', async function () {
        const t0 = process.hrtime.bigint();
        await processBlocks(indexer);
        const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;

        // Expected genesis actions: pass 1 issues every row (ISSUE), pass 2 transfers
        // every row whose owner != GAS. On regtest the GAS address is a regtest address
        // that never appears in a mainnet snapshot, so all rows get a pass-2 transfer:
        // 2 * rowCount issue-table rows, and rowCount distinct tickers.
        const issues   = await countRows(indexerQuery, 'issues', '1=1', []);
        const tickers  = await countRows(indexerQuery, 'index_tickers', '1=1', []);
        const balances = await countRows(indexerQuery, 'balances', '1=1', []);

        const perSec = Math.round((issues / elapsedMs) * 1000);
        console.log('\nGENESIS PERF [' + COIN + ']: ' + rowCount + ' manifest rows -> '
            + issues + ' issue/transfer actions in ' + (elapsedMs / 1000).toFixed(1) + 's '
            + '(' + perSec + ' actions/s); watchdog = ' + (timeoutMs / 60000) + ' min.');

        assert.strictEqual(tickers, rowCount, 'every manifest name created a ticker');
        assert.strictEqual(issues, rowCount * 2, 'pass-1 issue + pass-2 transfer per row');
        assert.strictEqual(balances, 0, 'genesis creates zero balances');
        assert.ok(elapsedMs < timeoutMs,
            'genesis block must complete inside GENESIS_BLOCK_TIMEOUT_MS ('
            + (elapsedMs / 1000).toFixed(1) + 's vs ' + (timeoutMs / 1000) + 's limit)');
    });
});
