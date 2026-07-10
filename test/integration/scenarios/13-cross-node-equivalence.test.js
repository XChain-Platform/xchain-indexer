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
 * Integration tests: 13 - CROSS-NODE EQUIVALENCE (P2a, test-framework program)
 *
 * Two INDEPENDENT indexer instances (separate indexer DBs) process the SAME
 * decoder DB. The consensus property: their resolved hash chains must be
 * identical at every height, and their databases equivalent (see
 * setup/equivalence.js for the strict/content modes).
 *
 * Scenario 10 pins the hash chain of ONE node against a committed baseline
 * (sequential re-runs through the same DB). This suite is the cross-NODE
 * statement: two simultaneous nodes (1), a live-follower vs a catch-up
 * node (2), and (the June prod bug class) a node that LIVED THROUGH a
 * reorg vs a node that fresh-parses the surviving chain afterwards (3, 4).
 *
 * Case 4 is the sharp edge: getBlockHashes folds raw dedup ids
 * (address_id / tick_id / action_id / status_id) into the consensus hashes,
 * and rollback.js never deletes index_* rows. If orphaned blocks introduce
 * NEW dedup entities, the survivor's id high-water mark moves; whether a
 * fresh re-parse then assigns the same ids to LATER novel entities decides
 * whether a resynced-from-genesis node can ever rejoin the federation.
 */

'use strict';

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
const T_FAR_FUTURE = T0 + 86400 * 30;

// Deterministic base corpus: ledger movement, escrows (ORDER match,
// DISPENSER), token destruction: blocks 100..107 (gas preamble at 99).
function baseCorpus() {
    return [
        { block: 100, time: T0,           txs: [{ source: ADDR1, data: 'ISSUE|0|EQTA|1000000|1000|0|cross-node equivalence A' }] },
        { block: 101, time: T0 + BLK,     txs: [{ source: ADDR2, data: 'ISSUE|0|EQTB|500000|500|0|cross-node equivalence B' }] },
        { block: 102, time: T0 + BLK * 2, txs: [
            { source: ADDR1, data: 'MINT|0|EQTA|800' },
            { source: ADDR2, data: 'MINT|0|EQTB|400' },
        ] },
        { block: 103, time: T0 + BLK * 3, txs: [
            { source: ADDR1, destination: ADDR2, data: 'SEND|0|EQTA|150|' + ADDR2 },
            { source: ADDR2, destination: ADDR1, data: 'SEND|0|EQTB|75|' + ADDR1 },
        ] },
        { block: 104, time: T0 + BLK * 4, txs: [
            { source: ADDR1, data: 'ORDER|0|BTC|EQTA|10|0|BTC|EQTB|20|0|' + ADDR1 + '|' + T_FAR_FUTURE + '|||' },
            { source: ADDR2, data: 'ORDER|0|BTC|EQTB|20|0|BTC|EQTA|10|0|' + ADDR2 + '|' + T_FAR_FUTURE + '|||' },
        ] },
        { block: 105, time: T0 + BLK * 5, txs: [
            // ADDR3 permits third-party dispensers at its address (ADDRESS
            // option 2), then ADDR1 opens one (escrows 50 EQTA).
            { source: ADDR3, data: 'ADDRESS|0|||2|' },
            { source: ADDR1, data: 'DISPENSER|0|BTC|EQTA|10|0|50|BTC|EQTB|1|' + ADDR3 + '||||' + T_FAR_FUTURE + '|||' },
        ] },
        { block: 106, time: T0 + BLK * 6, txs: [{ source: ADDR1, data: 'MINT|0|EQTA|40' }] },
        { block: 107, time: T0 + BLK * 7, txs: [{ source: ADDR1, data: 'DESTROY|0|EQTA|20|burning tokens' }] },
    ];
}
const BASE_BLOCKS = 9; // gas preamble + 100..107

async function seedBaseCorpus(seeder) {
    await seedGas(seeder, { blockIndex: 99, addresses: [ADDR1, ADDR2, ADDR3] });
    for (const b of baseCorpus()) await seeder.seedBlock(b.block, b.time, b.txs);
}

/** Delete decoder blocks >= blockIndex (same pattern as scenario 05). */
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

describe('13 – Cross-node equivalence @regression @tier1', function () {
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

    // -----------------------------------------------------------------------
    // 1. Two independent nodes over identical history -> byte-identical DBs
    // -----------------------------------------------------------------------
    it('1. two nodes over the same decoder DB are byte-identical (ids included)', async function () {
        const seeder = new DecoderSeeder(decoderQuery);
        await seedBaseCorpus(seeder);

        const nodeA = await initIndexer();
        const processedA = await processBlocks(nodeA);
        await destroyIndexer(nodeA);
        assert.strictEqual(processedA, BASE_BLOCKS);

        const chainB = await runNodeB();
        const chainA = await readHashChain(indexerQuery);

        assertHashChainsEqual(chainA, chainB);
        await assertIndexerDbsEquivalent(indexerQuery, indexerBQuery, { mode: 'strict' });
        await assertStateInvariants(indexerQuery);
        await assertStateInvariants(indexerBQuery);
    });

    // -----------------------------------------------------------------------
    // 2. Live-follower vs catch-up node: processing SCHEDULE is irrelevant
    // -----------------------------------------------------------------------
    it('2. a block-by-block follower equals a single catch-up pass', async function () {
        const seeder = new DecoderSeeder(decoderQuery);

        // Node A follows live: process after every seeded block.
        const nodeA = await initIndexer();
        try {
            await seedGas(seeder, { blockIndex: 99, addresses: [ADDR1, ADDR2, ADDR3] });
            await processBlocks(nodeA);
            for (const b of baseCorpus()) {
                await seeder.seedBlock(b.block, b.time, b.txs);
                await processBlocks(nodeA);
            }
        } finally {
            await destroyIndexer(nodeA);
        }

        // Node B catches up over the finished corpus in one pass.
        const chainB = await runNodeB();
        const chainA = await readHashChain(indexerQuery);

        assertHashChainsEqual(chainA, chainB, 'follower', 'catch-up');
        await assertIndexerDbsEquivalent(indexerQuery, indexerBQuery,
            { mode: 'strict', labelA: 'follower', labelB: 'catch-up' });
    });

    // -----------------------------------------------------------------------
    // 3. Reorg survivor vs fresh resync: replacement reuses known entities
    // -----------------------------------------------------------------------
    it('3. a reorg survivor equals a fresh re-parse (replacement reuses known entities)', async function () {
        const seeder = new DecoderSeeder(decoderQuery);
        await seedBaseCorpus(seeder);

        // Node A lives through the whole history including the reorg.
        let nodeA = await initIndexer();
        await processBlocks(nodeA);
        await destroyIndexer(nodeA);

        // Reorg at 106: orphan the MINT+DESTROY, replace with actions that
        // touch ONLY already-indexed entities (addresses, ticks, action
        // types) so no NEW dedup ids are assigned on either side.
        await seeder.seedReorgEvent([106]);
        await deleteDecoderBlocksFrom(106);
        await seeder.seedBlock(106, T0 + BLK * 6, [{ source: ADDR1, data: 'MINT|0|EQTA|5' }]);
        await seeder.seedBlock(107, T0 + BLK * 7, [
            { source: ADDR1, destination: ADDR3, data: 'SEND|0|EQTA|30|' + ADDR3 },
        ]);

        nodeA = await initIndexer();
        await processBlocks(nodeA);
        await destroyIndexer(nodeA);

        // Node B fresh-parses the surviving chain only (a from-genesis resync).
        const chainB = await runNodeB();
        const chainA = await readHashChain(indexerQuery);

        assertHashChainsEqual(chainA, chainB, 'survivor', 'resync');
        await assertIndexerDbsEquivalent(indexerQuery, indexerBQuery,
            { mode: 'content', labelA: 'survivor', labelB: 'resync' });
        await assertStateInvariants(indexerQuery);
        await assertStateInvariants(indexerBQuery);
    });

    // -----------------------------------------------------------------------
    // 4. Reorg survivor vs fresh resync: ORPHANS introduced novel entities
    //
    // The orphaned block ISSUEs a token (ORPH) that the surviving chain never
    // has. The survivor's index_tickers retains the ORPH row as residue; the
    // post-reorg history then ISSUEs another NEW token (POST). If dedup-id
    // assignment is not history-independent, POST gets a different tick_id on
    // the survivor than on a fresh resync, the ids are folded into the ledger
    // hash, and the two nodes FORK. A resynced validator could then never
    // rejoin, and ANCHOR's recover-from-chain-parse promise breaks.
    //
    // This is the seam that most directly detects silent consensus forking:
    // it asserts cross-node ledger-hash equivalence after a reorg whose
    // orphaned branch minted novel entities. It was skipped 2026-06-12 as a
    // CONFIRMED CONSENSUS FORK (P2a finding #1: getBlockHashes folded raw
    // index_* ids into the hash while rollback never deleted index_* rows;
    // see claude/reports/2026-06-12_p2a-cross-node-equivalence.md). Both
    // consensus-side fixes have since landed - getBlockHashes hashes the
    // RESOLVED address/ticker strings, and rollback.js block-scope-deletes
    // index_addresses/index_tickers - so the guard is live again (re-enabled
    // 2026-07-09 after a green run against the fixed code).
    // -----------------------------------------------------------------------
    it('4. survivor equals resync even when ORPHANED blocks introduced novel entities', async function () {
        const seeder = new DecoderSeeder(decoderQuery);
        await seedBaseCorpus(seeder);

        let nodeA = await initIndexer();
        await processBlocks(nodeA);
        await destroyIndexer(nodeA);

        // Extend the original history with an orphan-to-be that mints a NOVEL
        // token: index_tickers/index_transactions ids are assigned for it.
        await seeder.seedBlock(108, T0 + BLK * 8, [
            { source: ADDR2, data: 'ISSUE|0|ORPH|100000|100|0|doomed to orphanhood' },
        ]);
        nodeA = await initIndexer();
        await processBlocks(nodeA);
        await destroyIndexer(nodeA);

        // Reorg block 108 away; the replacement history mints a DIFFERENT
        // novel token. On the survivor its dedup ids land AFTER the ORPH
        // residue; on a fresh resync ORPH never existed.
        await seeder.seedReorgEvent([108]);
        await deleteDecoderBlocksFrom(108);
        await seeder.seedBlock(108, T0 + BLK * 8, [
            { source: ADDR2, data: 'ISSUE|0|POST|200000|200|0|the chain that survived' },
        ]);
        await seeder.seedBlock(109, T0 + BLK * 9, [
            { source: ADDR2, data: 'MINT|0|POST|150' },
        ]);

        nodeA = await initIndexer();
        await processBlocks(nodeA);
        await destroyIndexer(nodeA);

        const chainB = await runNodeB();
        const chainA = await readHashChain(indexerQuery);

        assertHashChainsEqual(chainA, chainB, 'survivor', 'resync');
        await assertIndexerDbsEquivalent(indexerQuery, indexerBQuery,
            { mode: 'content', labelA: 'survivor', labelB: 'resync' });
    });
});
