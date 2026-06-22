/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Integration tests: genesis ledger bootstrap (Counterparty/Dogeparty name
 * ownership injection). Verifies the two-pass GAS-issue-then-transfer at the
 * configured genesis block: every name exists with valid ISSUE + TRANSFER, the
 * deep-nested and divergent-owner cases land on the right owners, no balances are
 * created, the genesis block is a rollback floor, and a reindex reproduces the
 * identical ledger/actions hashes (consensus determinism). See src/genesis.js.
 */

'use strict';

const assert = require('assert');
const path   = require('path');
const { decoderQuery, indexerQuery, createDatabases, createDecoderSchema,
        resetDecoderDb, resetIndexerDb, closeAll } = require('../setup/db-connection');
const DecoderSeeder = require('../setup/decoder-seeder');
const { initIndexer, processBlocks, destroyIndexer } = require('../setup/indexer-launcher');
const { assertTokenOwner, countRows } = require('../setup/assertion-helpers');

const GENESIS_BLOCK = 100;
const BASE_TIME     = 1700000000;
const GAS   = 'mgash6jYSKAR3Q5HPpDgNX2BYr18q9N6GQ';            // BTC regtest GAS address
const ALICE = '1AaaAliceownsthissubassetnotrootXqf';          // mainnet-format (wrong-network on regtest)
const BOB   = '1BbbBobownsthedeepleafnodeXXXXXm4Hsa';

describe('Genesis Ledger Bootstrap @regression', function () {
    this.timeout(60000);

    let seeder, indexer;

    before(async function () {
        // Bind genesis to a current regtest block + the bundled test manifest. Config reads
        // these (regtest branch) at initIndexer time. Cleared in after() so no other suite
        // sharing this process injects at block 100.
        process.env.XCHAIN_GENESIS_BLOCK = String(GENESIS_BLOCK);
        process.env.GENESIS_LEDGER_PATH  = path.join(__dirname, '../../../data/genesis/ledger-test.csv');
        await createDatabases();
        await createDecoderSchema();
    });

    beforeEach(async function () {
        await resetDecoderDb();
        await resetIndexerDb();
        seeder = new DecoderSeeder(decoderQuery);
        // An empty block at the genesis height is enough; the injector runs before the
        // (here empty) real-transaction loop.
        await seeder.seedBlock(GENESIS_BLOCK, BASE_TIME, []);
        indexer = await initIndexer();
    });

    afterEach(async function () {
        await destroyIndexer(indexer);
    });

    after(async function () {
        delete process.env.XCHAIN_GENESIS_BLOCK;
        delete process.env.GENESIS_LEDGER_PATH;
        await closeAll();
    });

    it('injects every manifest name with the correct owner (GAS, divergent, and deep-nested)', async function () {
        await processBlocks(indexer);

        // Root + synthesized intermediates stay with GAS; divergent + deep leaves go to their owners.
        await assertTokenOwner(indexerQuery, 'FLDC', GAS);
        await assertTokenOwner(indexerQuery, 'FLDC.SCARCE', ALICE);          // subasset owner != root owner
        await assertTokenOwner(indexerQuery, 'PEPECASH', GAS);
        await assertTokenOwner(indexerQuery, 'PEPECASH.RARE', GAS);          // intermediate
        await assertTokenOwner(indexerQuery, 'PEPECASH.RARE.GOLD', BOB);     // 3-deep leaf, divergent owner
    });

    it('records a valid ISSUE/TRANSFER chain of custody and no balances', async function () {
        await processBlocks(indexer);

        // 5 pass-1 ISSUEs + 2 pass-2 TRANSFERs (only the 2 non-GAS owners) = 7 issue rows, all valid.
        const issues = await indexerQuery(
            `SELECT s.status FROM issues i INNER JOIN index_statuses s ON s.id = i.status_id
             ORDER BY i.action_index ASC`
        );
        assert.strictEqual(issues.length, 7, 'expected 7 issue rows (5 issue + 2 transfer)');
        assert.ok(issues.every(r => r.status === 'valid'), 'every genesis issue/transfer is valid');

        // Name ownership only: genesis mints no supply, so no balances exist.
        const balances = await countRows(indexerQuery, 'balances', '1=1', []);
        assert.strictEqual(balances, 0, 'genesis creates zero balances');
    });

    it('treats the genesis block as a rollback floor', async function () {
        await processBlocks(indexer);
        await assert.rejects(
            () => indexer.rollback.rollback(GENESIS_BLOCK),
            /refused/,
            'rollback to the genesis block must be refused'
        );
    });

    it('is deterministic across a full reindex (identical ledger/actions hashes)', async function () {
        await processBlocks(indexer);
        const h1 = await indexer.indexerDb.getBlockHashes(GENESIS_BLOCK);

        // Wipe the indexer DB and reprocess the same decoder data from scratch.
        await destroyIndexer(indexer);
        await resetIndexerDb();
        indexer = await initIndexer();
        await processBlocks(indexer);
        const h2 = await indexer.indexerDb.getBlockHashes(GENESIS_BLOCK);

        assert.strictEqual(h1.ledger.hash,  h2.ledger.hash,  'ledger hash stable across reindex');
        assert.strictEqual(h1.actions.hash, h2.actions.hash, 'actions hash stable across reindex');
    });
});
