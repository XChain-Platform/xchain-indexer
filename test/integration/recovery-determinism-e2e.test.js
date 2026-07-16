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
 *
 * RECOVERY-DETERMINISM E2E (consensus) - F1a P3 acceptance gate.
 *
 * The full cross-node proof that recovery is deterministic after F1a: build a
 * from-genesis node A and a recovered node B over the IDENTICAL chain, where the
 * only difference is HOW the anchor reward arrives:
 *
 *   - Node A (from-genesis): processes the chain in-block, then the live hub push
 *     writes the anchor reward via the REAL createValidatorReward (source resolved
 *     through the on-chain stake).
 *   - Node B (recovered): the REAL AnchorRecovery.run() restores a signed archive
 *     carrying the same reward (stages it by raw source-address string into
 *     recovery_pending_rewards), THEN the BTC reindex replays the identical chain
 *     and createAddress's F1a apply hook materializes the reward under the
 *     deterministic source_id.
 *
 * Asserts the three P3 invariants:
 *   (1) computeIndexMapChecksum(A) == computeIndexMapChecksum(B)   (the id map)
 *   (2) validator_rewards rows byte-identical A vs B                (reward parity)
 *   (3) getUnclaimedRewardTotal(source) equal A vs B               (COLLECT total)
 *
 * Pre-F1a this forked: recovery's out-of-band pre-seed offset node B's whole id
 * map, so (1) and (2) diverged. Needs a real MariaDB; set TEST_DB_HOST/PORT/USER/
 * PASS (self-skips without TEST_DB_PASS). Runs in CI via the integration tier's
 * test/integration/** glob , which provides the DB service.
 * See claude/reports/2026-06-19_id-determinism-F1-implementation-plan.md.
 *
 ********************************************************************/
'use strict';

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert  = require('assert');
const fs      = require('fs');
const path    = require('path');
const mariadb = require('mariadb');

const { getTestConfig } = require('../fixtures/config');
const { makeKeypair, buildBatch, rawMatch } = require('../fixtures/anchor-archive.js');
const Utility        = require('../../src/utility');
const Database       = require('../../src/db');
const AnchorRecovery = require('../../src/recovery.js');
const { buildStateHashData, INDEX_MAP_STATE_HASH_ACTIVATION } = require('../../src/stateHash');

const DB_HOST = process.env.TEST_DB_HOST || '127.0.0.1';
const DB_PORT = parseInt(process.env.TEST_DB_PORT) || 3306;
const DB_USER = process.env.TEST_DB_USER || 'root';
const DB_PASS = process.env.TEST_DB_PASS;            // undefined => self-skip

const DB_A      = 'xchain_recdet_a_btc';     // from-genesis node A (BTC indexer)
const DB_B_BTC  = 'xchain_recdet_b_btc';     // recovered node B (BTC indexer)
const DB_B_DOGE = 'xchain_recdet_b_doge';    // recovered node B archive source (DOGE indexer)
const ALL_DBS   = [DB_A, DB_B_BTC, DB_B_DOGE];

const util = new Utility();
util.logError = () => {};

// The chain both nodes replay, identically. Per-block lists of addresses created
// in a fixed in-block order (mirrors deterministic createAddress assignment).
const STAKE_SOURCE = 'btc1qStakeSource';
const CHAIN = [
    { block: 1, addrs: [STAKE_SOURCE, 'btc1qAaa'] },
    { block: 2, addrs: ['btc1qBbb'] },
];
const EARN_BLOCK    = 3;            // anchor reward earn-block (carried onto validator_rewards)
const COLLECT_BLOCK = 4;
// anchor_<chain> reward amounts are consensus-frozen at/above the anchor-reward
// flag-day (regtest = genesis-active): the live push path credits
// ANCHOR_REWARD_AMOUNT and recovery pins the archived amount to it. Node A must
// credit the frozen amount like a real live node; the ARCHIVE keeps a deliberately
// wrong 5.00000000 so this suite also proves recovery pins a forged amount.
const ar            = require('../../src/anchor_reward_activation');
const REWARD_AMOUNT = ar.ANCHOR_REWARD_AMOUNT;
const FORGED_ARCHIVE_AMOUNT = '5.00000000';
const REWARD_ROUND  = 1;
const REWARD_TYPE   = 'anchor_BTC';

const VALIDATOR = makeKeypair();   // the reward's signing validator (independent of federation signers)

async function admin() {
    return mariadb.createConnection({ host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASS, multipleStatements: true });
}

async function freshDb(name) {
    const a = await admin();
    await a.query('DROP DATABASE IF EXISTS ' + name + '; CREATE DATABASE ' + name + ';');
    await a.end();
    const db = new Database(DB_HOST, DB_PORT, name, DB_USER, DB_PASS, { config: getTestConfig(), util });
    // verifyTables() is the canonical schema loader (creates every src/sql table). Silence
    // its 100+ "Verifying ... table exists" lines for a readable test run.
    const realLog = console.log;
    console.log = () => {};
    try { await db.verifyTables(); } finally { console.log = realLog; }
    return db;
}

// Replay the chain in-block on a BTC indexer DB: deterministic createAddress per block,
// plus the STAKE row binding the validator pubkey to the stake source (so node A's
// createValidatorReward resolves the source on-chain). On node B, createAddress's apply
// hook materializes the staged reward when STAKE_SOURCE first gets its id.
async function replayChain(db) {
    for (const b of CHAIN) {
        await db.beginTransaction();
        db.blockIndex = b.block;
        for (const a of b.addrs) await db.createAddress(a);
        if (b.block === 1) {
            const srcId   = await db.getAddressId(STAKE_SOURCE);
            const pkId    = await db.getOrCreatePubkeyId(VALIDATOR.pubkey.toLowerCase());
            const validId = await db.createStatus('valid');
            await db.doQuery(
                `INSERT INTO stakes
                    (action_index, source_id, version, signing_pubkey_id, amount, status_id,
                     block_index, activation_block, deactivation_block)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [1001, srcId, 1, pkId, '100', validId, b.block, 0, null]);
        }
        await db.commitTransaction();
    }
}

// Seed node B's DOGE indexer with a signed anchor archive carrying the reward.
async function seedArchive(dogeDb) {
    const oracleKeys = [makeKeypair(), makeKeypair(), makeKeypair(), makeKeypair()];
    const crossKeys  = [makeKeypair(), makeKeypair(), makeKeypair(), makeKeypair()];
    const reward = {
        source: STAKE_SOURCE, validator_pubkey: VALIDATOR.pubkey,
        reward_type: REWARD_TYPE, round_number: REWARD_ROUND,
        amount: FORGED_ARCHIVE_AMOUNT, block_index: EARN_BLOCK,
    };
    const { v1, v2s } = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys, { rewards: [reward] });
    // recovery.run() joins index_statuses and restricts to status IN ('valid','unverified'), so the
    // seeded v1 MUST carry a real status_id (a NULL status_id is dropped by the INNER JOIN, which is
    // a fixture defect, not a reason to loosen the query). anchor.js defaults a clean parse to 'valid'.
    const validStatusId = await dogeDb.createStatus('valid');
    await dogeDb.doQuery(
        `INSERT INTO anchor_actions
            (action_index, version, chain, network, block_index, block_hash, ledger_hash,
             actions_hash, contract_hash, checkpoint_seq, snapshot_block, match_batch_seq,
             match_count, batch_crc32, total_chunks, archive_b64, validator_signatures, status_id, block_index_doge)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [1, v1.version, v1.chain, v1.network, v1.block_index, v1.block_hash, v1.ledger_hash,
         v1.actions_hash, v1.contract_hash, v1.checkpoint_seq, v1.snapshot_block, v1.match_batch_seq,
         v1.match_count, v1.batch_crc32, v1.total_chunks, v1.archive_b64, v1.validator_signatures, validStatusId, 500]);
    let ai = 2;
    for (const c of v2s) {
        await dogeDb.doQuery(
            `INSERT INTO anchor_actions
                (action_index, version, match_batch_seq, chunk_index, total_chunks, archive_b64, block_index_doge)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [ai++, c.version, c.match_batch_seq, c.chunk_index, c.total_chunks, c.archive_b64, 500]);
    }
}

// The advisory index-map checksum, computed identically to xchain-sync
// BlockHasher.computeIndexMapChecksum (same query, same util.getDataHash).
async function indexMapChecksum(db, uptoBlock) {
    const rows = await db.doQuery(
        "SELECT id, address FROM index_addresses WHERE block_index IS NOT NULL AND block_index <= ? ORDER BY id ASC",
        [uptoBlock]);
    const mapped = rows.map(r => ({ id: String(r.id), address: String(r.address) }));
    return util.getDataHash({ index_map: mapped });
}

// Normalize validator_rewards rows (BIGINT columns may arrive as number/BigInt) for
// a collation- and type-independent deepStrictEqual.
async function rewardRows(db) {
    const rows = await db.doQuery(
        "SELECT source_id, signing_pubkey_id, reward_type, round_reference, amount, block_index " +
        "FROM validator_rewards ORDER BY source_id, signing_pubkey_id, reward_type, round_reference");
    return rows.map(r => ({
        source_id:         String(r.source_id),
        signing_pubkey_id: String(r.signing_pubkey_id),
        reward_type:       String(r.reward_type),
        round_reference:   String(r.round_reference),
        amount:            String(r.amount),
        block_index:       String(r.block_index),
    }));
}

describe('Recovery-determinism e2e (consensus) @integration', function () {
    this.timeout(120000);
    let A, Bbtc, Bdoge;

    before(async function () {
        if (DB_PASS === undefined) { this.skip(); return; }
        try {
            const c = await mariadb.createConnection({ host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASS, connectTimeout: 4000 });
            await c.query('SELECT 1'); await c.end();
        } catch (e) { this.skip(); return; }

        // Node A: from-genesis. Replay the chain, then the live hub push writes the
        // anchor reward through the REAL createValidatorReward (on-chain source resolution).
        A = await freshDb(DB_A);
        await replayChain(A);
        const ok = await A.createValidatorReward(VALIDATOR.pubkey.toLowerCase(), REWARD_ROUND, REWARD_TYPE, REWARD_AMOUNT, EARN_BLOCK);
        assert.strictEqual(ok, true, 'node A: live hub-push reward must be created');

        // Node B: recovered. REAL AnchorRecovery.run() stages the archived reward, THEN
        // the reindex replays the identical chain and the apply hook materializes it.
        Bbtc  = await freshDb(DB_B_BTC);
        Bdoge = await freshDb(DB_B_DOGE);
        await seedArchive(Bdoge);
        const report = await new AnchorRecovery(Bdoge, { btcDb: Bbtc, util, log: () => {} }).run();
        assert.strictEqual(report.failed.length, 0, 'recovery batch must verify: ' + JSON.stringify(report.failed));
        assert.strictEqual(report.rewards, 1, 'recovery must stage exactly 1 reward');
        await replayChain(Bbtc);
    });

    after(async function () {
        for (const db of [A, Bbtc, Bdoge]) { if (db && db.pool) { try { await db.pool.end(); } catch (e) {} } }
        if (DB_PASS === undefined) return;
        try { const a = await admin(); for (const n of ALL_DBS) await a.query('DROP DATABASE IF EXISTS ' + n); await a.end(); } catch (e) {}
    });

    it('sanity: both nodes assigned the stake source the same deterministic id', async function () {
        const idA = await A.getAddressId(STAKE_SOURCE);
        const idB = await Bbtc.getAddressId(STAKE_SOURCE);
        assert.strictEqual(Number(idB), Number(idA));
        assert.ok(Number(idA) > 0);
    });

    it('(1) index-map checksum is IDENTICAL across the recovery boundary', async function () {
        const a = await indexMapChecksum(A, COLLECT_BLOCK);
        const b = await indexMapChecksum(Bbtc, COLLECT_BLOCK);
        assert.strictEqual(b, a, 'recovered node must reproduce the from-genesis index-map checksum');
    });

    it('(2) validator_rewards are byte-identical across the recovery boundary', async function () {
        const rewA = await rewardRows(A);
        const rewB = await rewardRows(Bbtc);
        assert.strictEqual(rewA.length, 1, 'node A has exactly the one anchor reward');
        assert.deepStrictEqual(rewB, rewA, 'recovered validator_rewards must match from-genesis row-for-row');
        // And the reward sits under the deterministic source id (not an offset one).
        const idA = String(await A.getAddressId(STAKE_SOURCE));
        assert.strictEqual(rewA[0].source_id, idA);
        assert.strictEqual(rewA[0].block_index, String(EARN_BLOCK));
    });

    it('(3) COLLECT unclaimed total is equal across the recovery boundary', async function () {
        const totA = await A.getUnclaimedRewardTotal(STAKE_SOURCE, COLLECT_BLOCK);
        const totB = await Bbtc.getUnclaimedRewardTotal(STAKE_SOURCE, COLLECT_BLOCK);
        assert.strictEqual(String(totB), String(totA), 'COLLECT must credit the same amount on both nodes');
        assert.ok(util.bcgt(totA, '0'), 'the reward must actually be collectable (> 0)');
    });

    // P4: with the index-map class ARMED in state_hash, the recovered node must produce a
    // per-block state_hash byte-identical to the from-genesis node (no false halt), and the
    // class must actually be folded in (armed hash differs from the inert hash). This is the
    // enforcement the advisory checksum is promoted to: a divergent id map would change
    // state_hash and HALT the follower; an identical map (the F1a guarantee) does not.
    it('(4) P4 armed: per-block state_hash is identical A vs B, and the id map is enforced', async function () {
        const opts = (network) => ({ activationDelay: null, gasTick: 'XCHAIN', network });
        const prev = INDEX_MAP_STATE_HASH_ACTIVATION.regtest;
        INDEX_MAP_STATE_HASH_ACTIVATION.regtest = 0;   // arm for this assertion only
        try {
            for (const b of CHAIN) {
                const armedA = util.getDataHash(await buildStateHashData(A,    b.block, opts('regtest')));
                const armedB = util.getDataHash(await buildStateHashData(Bbtc, b.block, opts('regtest')));
                assert.strictEqual(armedB, armedA,
                    'block ' + b.block + ': recovered state_hash must match from-genesis (no false halt)');
                // The class is genuinely active: arming changes the hash vs inert (id map is folded in).
                const inertA = util.getDataHash(await buildStateHashData(A, b.block, opts('mainnet')));   // mainnet placeholder = inert
                assert.notStrictEqual(armedA, inertA,
                    'block ' + b.block + ': armed state_hash must fold in the id map (differ from inert)');
            }
        } finally {
            INDEX_MAP_STATE_HASH_ACTIVATION.regtest = prev;
        }
    });
});
