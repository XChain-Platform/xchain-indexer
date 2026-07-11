'use strict';

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
 * Integration tests: 16 - ROLLBACK REPLAY IDEMPOTENCY
 *
 * The behavioral gap left open by the rollback test suite (review 4ce091e9):
 * every direct rollback.js unit test is mock/spy based (it stubs indexerDb
 * and asserts which SQL strings are issued). Nothing exercised the load-bearing
 * invariant behaviorally: applying a block, rolling it back, then re-applying
 * the SAME block must leave the database in the same state as a fresh
 * from-genesis replay of that block sequence.
 *
 * This drives it end-to-end against the real test MariaDB. Node A lives through
 * apply -> reorg-rollback -> re-apply of IDENTICAL replacement blocks (so the
 * only difference from a fresh parse is rollback residue: AUTO_INCREMENT high-
 * water marks and never-deleted index_* dedup rows). Node B fresh-parses the
 * same final chain from genesis. The two databases must be equivalent in
 * CONTENT mode (setup/equivalence.js), which normalizes exactly those local
 * artifacts and, critically, asserts the resolved consensus hash chain is
 * byte-identical. Strict id-level equality is a KNOWN, intentionally-skipped
 * consensus-fork divergence (see 13-cross-node-equivalence case 4); this test
 * does not attempt it.
 */

const assert = require('assert');
const {
    decoderQuery, indexerQuery, indexerBQuery,
    createDatabases, createDecoderSchema,
    resetDecoderDb, resetIndexerDb, resetIndexerDbB,
    closeAll, INDEXER_DB_B,
} = require('../setup/db-connection');
const DecoderSeeder = require('../setup/decoder-seeder');
const { initIndexer, processBlocks, destroyIndexer } = require('../setup/indexer-launcher');
const { seedGas } = require('../setup/gas-seeder');
const { assertStateInvariants } = require('../setup/state-invariants');
const { readHashChain, assertHashChainsEqual, assertIndexerDbsEquivalent }
    = require('../setup/equivalence');

const ADDR1 = 'mq7tVfobimRUPxPNnyd5mKn11SVmTiLxtu';
const ADDR2 = 'n4nbVcRRR5sEHyp2VYuLUvCyDmQmBoonoK';
const ADDR3 = 'mvuKWKvgzrkxh8QgNZ91vMBZUKN5BFYmo3';

const T0  = 1700000000;
const BLK = 600;

// A small self-contained corpus: token issue, mints, a send, then two blocks
// (106, 107) that we will rollback and re-apply identically. The re-applied
// blocks touch only already-indexed entities (no NEW dedup ids), so a fresh
// resync is content-equivalent to the reorg survivor.
function baseCorpus() {
    return [
        { block: 100, time: T0,           txs: [{ source: ADDR1, data: 'ISSUE|0|RPLY|1000000|1000|0|rollback replay idempotency' }] },
        { block: 101, time: T0 + BLK,     txs: [{ source: ADDR1, data: 'MINT|0|RPLY|800' }] },
        { block: 102, time: T0 + BLK * 2, txs: [{ source: ADDR1, destination: ADDR2, data: 'SEND|0|RPLY|150|' + ADDR2 }] },
        { block: 103, time: T0 + BLK * 3, txs: [{ source: ADDR1, destination: ADDR3, data: 'SEND|0|RPLY|40|' + ADDR3 }] },
    ];
}

// The two blocks that are rolled back and re-applied verbatim.
function replayedBlocks() {
    return [
        { block: 104, time: T0 + BLK * 4, txs: [{ source: ADDR1, data: 'MINT|0|RPLY|40' }] },
        { block: 105, time: T0 + BLK * 5, txs: [{ source: ADDR1, data: 'DESTROY|0|RPLY|20|burning tokens' }] },
    ];
}
const TOTAL_BLOCKS = 1 /* gas preamble */ + 4 /* base */ + 2 /* replayed */;

async function seedGasAndBase(seeder) {
    await seedGas(seeder, { blockIndex: 99, addresses: [ADDR1, ADDR2, ADDR3] });
    for (const b of baseCorpus()) await seeder.seedBlock(b.block, b.time, b.txs);
    for (const b of replayedBlocks()) await seeder.seedBlock(b.block, b.time, b.txs);
}

/** Delete decoder blocks >= blockIndex (same pattern as scenarios 05 / 13). */
async function deleteDecoderBlocksFrom(blockIndex) {
    await decoderQuery(
        'DELETE FROM transaction_outputs WHERE tx_index IN ' +
        '(SELECT tx_index FROM transactions WHERE block_index >= ?)',
        [blockIndex]);
    await decoderQuery('DELETE FROM transactions WHERE block_index >= ?', [blockIndex]);
    await decoderQuery('DELETE FROM blocks WHERE block_index >= ?', [blockIndex]);
}

/** Run a fresh node B over the current decoder DB and return its hash chain. */
async function runNodeB() {
    const nodeB = await initIndexer({ indexerName: INDEXER_DB_B });
    try {
        await processBlocks(nodeB);
        return await readHashChain(indexerBQuery);
    } finally {
        await destroyIndexer(nodeB);
    }
}

describe('16 – Rollback replay idempotency @regression @tier3', function () {
    this.timeout(180000);

    before(async function () {
        process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
        process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';
        await createDatabases();
        await createDecoderSchema();
    });

    after(async function () {
        await closeAll();
    });

    beforeEach(async function () {
        this.timeout(60000);
        await resetDecoderDb();
        await resetIndexerDb();
        await resetIndexerDbB();
    });

    it('apply -> rollback -> re-apply the SAME blocks equals a fresh from-genesis replay (content mode)', async function () {
        const seeder = new DecoderSeeder(decoderQuery);
        await seedGasAndBase(seeder);

        // Node A applies the full chain (100..105) live.
        let nodeA = await initIndexer();
        const processedA = await processBlocks(nodeA);
        await destroyIndexer(nodeA);
        assert.strictEqual(processedA, TOTAL_BLOCKS);

        // Reorg at 104: orphan blocks 104 and 105, then re-seed the IDENTICAL
        // block data as the replacement chain. processBlocks detects the reorg,
        // rolls back 104/105, and re-applies the same blocks verbatim.
        await seeder.seedReorgEvent([104, 105]);
        await deleteDecoderBlocksFrom(104);
        for (const b of replayedBlocks()) await seeder.seedBlock(b.block, b.time, b.txs);

        nodeA = await initIndexer();
        await processBlocks(nodeA);
        await destroyIndexer(nodeA);

        // Node B fresh-parses the identical final chain from genesis (a resync).
        const chainB = await runNodeB();
        const chainA = await readHashChain(indexerQuery);

        // The consensus commitment (resolved hash chain) must be byte-identical,
        // and the whole DB equivalent in content mode (id high-water marks and
        // never-deleted index_* residue normalized).
        assertHashChainsEqual(chainA, chainB, 'rollback-survivor', 'fresh-replay');
        await assertIndexerDbsEquivalent(indexerQuery, indexerBQuery,
            { mode: 'content', labelA: 'rollback-survivor', labelB: 'fresh-replay' });
        await assertStateInvariants(indexerQuery);
        await assertStateInvariants(indexerBQuery);
    });
});
