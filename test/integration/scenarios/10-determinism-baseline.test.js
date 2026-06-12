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
 * Integration test: indexer CROSS-NODE DETERMINISM baseline.
 *
 * Consensus safety rests on one property: two validators that process the same
 * decoder blocks MUST derive byte-identical indexer state, or the network forks.
 * The indexer already commits to its state with chained per-block hashes
 * (blocks.ledger_hash_id / actions_hash_id / contract_hash_id -> index_transactions.hash,
 * each folding in the previous block's hashes — see db.js:getBlockHashes). Those
 * hashes ARE the consensus commitment.
 *
 * The existing xchain-vm determinism-baseline pins single-contract VM output. This is
 * the platform-level analog: it pins the indexer's chained block hashes for a fixed
 * action corpus, so a semantic change in action processing (ledger math, ordering,
 * status assignment, hashing) is caught even though each run is still internally
 * deterministic. Two guards:
 *   1. run-twice-equal — re-deriving from a clean DB yields the identical hash chain.
 *   2. committed baseline — the chain matches INDEXER_STATE_BASELINE.json (drift = fork risk).
 *
 * Regenerate after an INTENTIONAL consensus change (review the diff!) — with the
 * usual TEST_DB_* env pointing at a disposable MariaDB:
 *   REGEN_INDEXER_STATE_BASELINE=1 INDEXER_COIN=BTC INDEXER_NETWORK=regtest \
 *   npx mocha --no-config test/integration/scenarios/10-determinism-baseline.test.js
 */

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { decoderQuery, indexerQuery, createDatabases, createDecoderSchema,
        resetDecoderDb, resetIndexerDb, closeAll } = require('../setup/db-connection');
const DecoderSeeder = require('../setup/decoder-seeder');
const { initIndexer, processBlocks, destroyIndexer } = require('../setup/indexer-launcher');
const { seedGas } = require('../setup/gas-seeder');

const BASELINE_PATH = path.join(__dirname, '..', 'INDEXER_STATE_BASELINE.json');
const REGEN = process.env.REGEN_INDEXER_STATE_BASELINE === '1';

const A1 = 'mq7tVfobimRUPxPNnyd5mKn11SVmTiLxtu'; // 30 chars
const A2 = 'n4nbVcRRR5sEHyp2VYuLUvCyDmQmBoonoK';
const A3 = 'mvuKWKvgzrkxh8QgNZ91vMBZUKN5BFYmo3';
const BASE_TIME = 1700000000;

// ---------------------------------------------------------------------------
// Fixed, deterministic action corpus. Order and contents are the contract —
// changing them invalidates the baseline (regenerate deliberately).
// ---------------------------------------------------------------------------
const CORPUS = [
    { block: 100, time: BASE_TIME,        txs: [{ source: A1, data: 'ISSUE|0|DETTOK|100000|1000|0|determinism corpus token' }] },
    { block: 101, time: BASE_TIME + 600,  txs: [{ source: A1, data: 'MINT|0|DETTOK|500' }] },
    { block: 102, time: BASE_TIME + 1200, txs: [{ source: A1, data: 'MINT|0|DETTOK|250' }] },
    { block: 103, time: BASE_TIME + 1800, txs: [{ source: A1, destination: A2, data: 'SEND|0|DETTOK|200|' + A2 }] },
    { block: 104, time: BASE_TIME + 2400, txs: [{ source: A2, destination: A3, data: 'SEND|0|DETTOK|75|' + A3 }] },
];

/** Read the indexer's chained consensus-hash triple for every block, ordered. */
async function readHashChain() {
    return indexerQuery(
        `SELECT b.block_index,
                t1.hash AS ledger,
                t2.hash AS actions,
                t3.hash AS contracts
         FROM blocks b
         LEFT JOIN index_transactions t1 ON t1.id = b.ledger_hash_id
         LEFT JOIN index_transactions t2 ON t2.id = b.actions_hash_id
         LEFT JOIN index_transactions t3 ON t3.id = b.contract_hash_id
         ORDER BY b.block_index ASC`
    );
}

/** Full clean run: fresh DBs, seed corpus, drive the real indexer, return the hash chain. */
async function runCorpus() {
    await resetDecoderDb();
    await resetIndexerDb();
    const seeder = new DecoderSeeder(decoderQuery);
    // Fee-era gas preamble (block 99, part of the pinned corpus): the ISSUE at
    // block 100 needs A1 to hold XCHAIN, and A2's SEND pays db-hit fees too.
    await seedGas(seeder, { addresses: [A1, A2, A3] });
    for (const b of CORPUS) await seeder.seedBlock(b.block, b.time, b.txs);

    const indexer = await initIndexer();
    try {
        const processed = await processBlocks(indexer);
        assert.strictEqual(processed, CORPUS.length + 1, // +1 = the gas preamble block
            `expected to process ${CORPUS.length + 1} blocks, processed ${processed}`);
        const chain = await readHashChain();
        // Normalize BIGINT block_index to a plain number for stable JSON.
        return chain.map(r => ({
            block_index: Number(r.block_index),
            ledger: r.ledger, actions: r.actions, contracts: r.contracts,
        }));
    } finally {
        await destroyIndexer(indexer);
    }
}

function chainDigest(chain) {
    return crypto.createHash('sha256').update(JSON.stringify(chain)).digest('hex');
}

describe('Indexer cross-node determinism baseline @regression @tier1', function () {
    this.timeout(60000);

    let firstChain;

    before(async function () {
        process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
        process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';
        await createDatabases();
        await createDecoderSchema();
        firstChain = await runCorpus();
    });

    after(async function () {
        await closeAll();
    });

    it('every block produced a ledger + actions consensus hash', function () {
        assert.strictEqual(firstChain.length, CORPUS.length + 1); // +1 = gas preamble block
        for (const row of firstChain) {
            assert.ok(row.ledger,  `block ${row.block_index} has no ledger hash`);
            assert.ok(row.actions, `block ${row.block_index} has no actions hash`);
        }
    });

    it('re-deriving the corpus from a clean DB yields the identical hash chain (determinism)', async function () {
        const secondChain = await runCorpus();
        assert.deepStrictEqual(secondChain, firstChain,
            'indexer produced different consensus hashes for the same input — non-determinism = fork risk');
    });

    it('hash chain matches the committed baseline (no consensus drift)', function () {
        const digest = chainDigest(firstChain);

        if (REGEN || !fs.existsSync(BASELINE_PATH)) {
            fs.writeFileSync(BASELINE_PATH,
                JSON.stringify({ digest, chain: firstChain }, null, 2) + '\n');
            console.log(`[indexer-determinism] wrote baseline (${REGEN ? 'REGEN' : 'file absent'}): ${BASELINE_PATH}`);
        }

        const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
        assert.strictEqual(digest, baseline.digest,
            'indexer consensus-hash chain no longer matches the committed baseline. If this is an ' +
            'intended consensus change, regenerate with REGEN_INDEXER_STATE_BASELINE=1 and review the diff.');
    });
});
