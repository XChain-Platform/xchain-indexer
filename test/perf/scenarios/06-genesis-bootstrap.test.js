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
// proven by integration scenario 22; this validates only that the genesis block
// (one create per name + one transfer per ancestor, ~124k actions on BTC) completes
// inside GENESIS_BLOCK_TIMEOUT_MS (30 min). Coin is chosen by INDEXER_COIN; run once
// per chain (BTC, then DOGE).

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

// Parse manifest ticks the way genesis.js _loadRows does (last comma splits tick from
// owner, RFC4180-unwrap a quoted tick), so the assertions track the bundled file rather
// than hardcoded numbers. Returns the in-order tick list (production manifests have no
// duplicate ticks, which the `tickers === rowCount` assertion also relies on).
function manifestTicks(file) {
    let ticks = [];
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        if (line === '' || line === 'tick,owner_address') continue;
        const comma = line.lastIndexOf(',');
        if (comma < 0) continue;
        let tick = line.slice(0, comma).trim();
        if (tick.length >= 2 && tick[0] === '"' && tick[tick.length - 1] === '"')
            tick = tick.slice(1, -1).replace(/""/g, '"');
        if (tick === '') continue;
        ticks.push(tick);
    }
    return ticks;
}

// Count ancestor ticks (a tick that is the parent-prefix of another present tick),
// mirroring genesis.js _ancestorSet. On regtest every owner is non-GAS, so the expected
// genesis issue rows are: one create per tick + one deferred transfer per ancestor.
function ancestorCount(ticks) {
    const present = new Set(ticks);
    const ancestors = new Set();
    for (const t of ticks) {
        const parts = t.split('.');
        for (let i = 1; i < parts.length; i++) {
            const prefix = parts.slice(0, i).join('.');
            if (present.has(prefix)) ancestors.add(prefix);
        }
    }
    return ancestors.size;
}

describe('06 Genesis Bootstrap (full-scale)', function () {
    this.timeout(0); // run under `npm run test:perf` (mocha --timeout 0)

    let seeder, indexer, rowCount, ancestors, timeoutMs;

    before(async function () {
        assert.ok(fs.existsSync(LEDGER_PATH),
            'bundled manifest missing: ' + LEDGER_PATH + ' (copy from snapshot/<source>/ledger.csv)');
        const ticks = manifestTicks(LEDGER_PATH);
        rowCount  = ticks.length;
        ancestors = ancestorCount(ticks);

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

        // Expected genesis actions: one create per row, plus one deferred transfer per
        // ancestor (a tick that is the parent-prefix of another). On regtest the GAS
        // address never appears in a mainnet snapshot, so every owner is non-GAS: leaves
        // fold their transfer into the create, ancestors transfer in the cleanup pass.
        // So issue-table rows = rowCount + ancestors, and rowCount distinct tickers.
        const expectedIssues = rowCount + ancestors;
        const issues   = await countRows(indexerQuery, 'issues', '1=1', []);
        const tickers  = await countRows(indexerQuery, 'index_tickers', '1=1', []);
        const balances = await countRows(indexerQuery, 'balances', '1=1', []);

        const perSec = Math.round((issues / elapsedMs) * 1000);
        console.log('\nGENESIS PERF [' + COIN + ']: ' + rowCount + ' manifest rows ('
            + ancestors + ' ancestors) -> ' + issues + ' issue actions in '
            + (elapsedMs / 1000).toFixed(1) + 's '
            + '(' + perSec + ' actions/s); watchdog = ' + (timeoutMs / 60000) + ' min.');

        assert.strictEqual(tickers, rowCount, 'every manifest name created a ticker');
        assert.strictEqual(issues, expectedIssues, 'one create per row + one transfer per ancestor');
        assert.strictEqual(balances, 0, 'genesis creates zero balances');
        assert.ok(elapsedMs < timeoutMs,
            'genesis block must complete inside GENESIS_BLOCK_TIMEOUT_MS ('
            + (elapsedMs / 1000).toFixed(1) + 's vs ' + (timeoutMs / 1000) + 's limit)');
    });
});
