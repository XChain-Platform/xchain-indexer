/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
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
 *
 * The two nodes of test/integration/recovery_determinism_e2e.test.js, and the
 * readers its assertions compare: node A from genesis and node B recovered
 * through the REAL AnchorRecovery.run(), over the identical chain. The
 * contract-heavy leg both nodes deploy is the sibling recovery_contract_leg.js.
 *
 * WHY THE BUILD IS SHARED. The suite is several consecutive describe blocks with
 * one title, so every full test title reads as it did when it was one block. The
 * first block's before() builds both nodes and every later block awaits that same
 * build, which is exactly what the single before() of the one-block suite did:
 * three schemas and a recovery run, once. The suite tears it down once, from a
 * root after() hook, with teardownRecoveredNodes().
 *
 * The requiring suite sets INDEXER_COIN and INDEXER_NETWORK before it requires
 * this file, because src/db reads them at load.
 *
 ********************************************************************/
'use strict';

const assert  = require('assert');
const mariadb = require('mariadb');

const { getTestConfig } = require('../../../fixtures/config');
const { makeKeypair, buildBatch, rawMatch } = require('../../../fixtures/anchor-archive.js');
const Utility        = require('../../../../src/utility');
const Database       = require('../../../../src/db');
const AnchorRecovery = require('../../../../bin/recovery.js');
const { sharedVm, shutdownVm, deployChunkedContract } = require('./recovery_contract_leg');

const DB_HOST = process.env.TEST_DB_HOST || '127.0.0.1';
const DB_PORT = parseInt(process.env.TEST_DB_PORT) || 3306;
const DB_USER = process.env.TEST_DB_USER || 'root';
const DB_PASS = process.env.TEST_DB_PASS;            // undefined => self-skip

// Database name prefix. Defaults to the historic `xchain_recdet` (unchanged in CI, whose
// integration DB service grants that user CREATE on any schema); overridable via TEST_DB_NS
// so a run against a least-privilege MariaDB (e.g. a dev box whose test user only holds DDL
// on `test_%` schemas) can point the three throwaway DBs at a grantable prefix without
// touching the assertions.
const NS        = process.env.TEST_DB_NS || 'xchain_recdet';
const DB_A      = NS + '_a_btc';     // from-genesis node A (BTC indexer)
const DB_B_BTC  = NS + '_b_btc';     // recovered node B (BTC indexer)
const DB_B_DOGE = NS + '_b_doge';    // recovered node B archive source (DOGE indexer)
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
const ar            = require('../../../../src/consensus/gates/anchor_reward_gate');
const REWARD_AMOUNT = ar.ANCHOR_REWARD_AMOUNT;
const FORGED_ARCHIVE_AMOUNT = '5.00000000';
const REWARD_ROUND  = 1;
const REWARD_TYPE   = 'anchor_BTC';
// The block the restored reward claims as its materialization block, and the only block it
// may land in: the fleet-agreed watermark above its archived earn-block.
const REWARD_DERIVE_BLOCK = ar.anchorRewardDeriveHeight(EARN_BLOCK);

const VALIDATOR = makeKeypair();   // the reward's signing validator (independent of federation signers)

// The DOGE address that publishes the seeded archive anchor: head and every continuation
// chunk are authored by it, which is what binds the chunks to the head.
const ARCHIVE_PUBLISHER = 'DArchivePublisher0000000000000000';

async function admin() {
    return mariadb.createConnection({ host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASS, multipleStatements: true });
}

async function freshDb(name) {
    const a = await admin();
    await a.query('DROP DATABASE IF EXISTS ' + name + '; CREATE DATABASE ' + name + ';');
    await a.end();
    const db = new Database(DB_HOST, DB_PORT, name, DB_USER, DB_PASS, { config: getTestConfig(), util });
    // verifyTables() is the canonical schema loader (creates every src/sql table). Silence
    // its summary lines and any drift-reconcile chatter for a readable test run.
    const realLog = console.log;
    console.log = () => {};
    try { await db.verifyTables(); } finally { console.log = realLog; }
    return db;
}

// Replay the chain in-block on a BTC indexer DB: deterministic createAddress per block,
// plus the STAKE row binding the validator pubkey to the stake source (so node A's
// createValidatorReward resolves the source on-chain). On node B this assigns the ids the
// staged reward will later be materialized under; the reward itself lands at its original
// derive height, well above this toy chain's tip.
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
    // Every anchor row also needs its `actions` row: a v2 continuation chunk is
    // now authenticated by matching the archive head's AUTHOR, resolved through
    // actions.source_id -> index_addresses, so a seeded anchor with no action linkage
    // resolves to a NULL author, matches nothing, and the batch reports 'incomplete
    // batch'. Same class of fixture defect as the NULL status_id noted above: seed the
    // linkage, never loosen the query. Head and chunks share ONE publisher, which is the
    // legitimate shape - a real batch is published by a single validator.
    dogeDb.blockIndex = 500;
    await dogeDb.createAddress(ARCHIVE_PUBLISHER);
    const publisherId = await dogeDb.getAddressId(ARCHIVE_PUBLISHER);
    const anchorActionId = await dogeDb.createAction('ANCHOR');
    const linkAction = (actionIndex, format) => dogeDb.doQuery(
        `INSERT INTO actions (action_index, block_index, tx_index, tx_vout, action_id, action_format, source_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [actionIndex, 500, actionIndex, 0, anchorActionId, format, publisherId]);
    await linkAction(1, 1);
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
        await linkAction(ai, 2);
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

// The nodes every block reads. Each is stored as soon as it exists, so a build
// that fails part way still hands the teardown every pool it opened.
const nodes = { A: null, Bbtc: null, Bdoge: null, contractLegRan: false };
let reachable = null;
let built = null;

async function dbReachable() {
    try {
        const c = await mariadb.createConnection({ host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASS, connectTimeout: 4000 });
        await c.query('SELECT 1'); await c.end();
        return true;
    } catch (e) { return false; }
}

// Node A: from-genesis. Replay the chain, then the live hub push writes the
// anchor reward through the REAL createValidatorReward (on-chain source resolution).
async function buildNodeA() {
    nodes.A = await freshDb(DB_A);
    await replayChain(nodes.A);
    const ok = await nodes.A.createValidatorReward(VALIDATOR.pubkey.toLowerCase(), REWARD_ROUND, REWARD_TYPE, REWARD_AMOUNT, EARN_BLOCK);
    assert.strictEqual(ok, true, 'node A: live hub-push reward must be created');
}

// Node B: recovered. REAL AnchorRecovery.run() stages the archived reward, THEN
// the reindex replays the identical chain and the apply hook materializes it.
async function buildNodeB() {
    nodes.Bbtc  = await freshDb(DB_B_BTC);
    nodes.Bdoge = await freshDb(DB_B_DOGE);
    await seedArchive(nodes.Bdoge);
    const report = await new AnchorRecovery(nodes.Bdoge, { btcDb: nodes.Bbtc, util, log: () => {} }).run();
    assert.strictEqual(report.failed.length, 0, 'recovery batch must verify: ' + JSON.stringify(report.failed));
    assert.strictEqual(report.rewards, 1, 'recovery must stage exactly 1 reward');
    await replayChain(nodes.Bbtc);
    // The reindex then reaches the height the reward was FIRST derived at (its
    // archived earn-block + the frozen mirror maturity). That, not the block its source
    // address happened to be interned in, is where a restored reward lands, so it carries
    // the same derive_block_index a live-derived row does and the reorg-scoping delete
    // cannot tell the two apart. Driven directly here; the indexer drives it per block,
    // beside deriveAnchorRewards.
    await nodes.Bbtc.beginTransaction();
    nodes.Bbtc.blockIndex = REWARD_DERIVE_BLOCK;
    await nodes.Bbtc.applyPendingRewardsDueAtBlock(REWARD_DERIVE_BLOCK);
    await nodes.Bbtc.commitTransaction();
}

async function buildNodes() {
    await buildNodeA();
    await buildNodeB();
    // Contract-heavy leg: deploy the SAME chunked contract on both nodes, across
    // the recovery boundary. Node A (from-genesis) records carriers in position order; node B
    // (recovered) records them in a DIFFERENT order, so the byte-identity below also proves
    // the assembler is independent of chunk delivery/storage order on a real engine.
    // A real DEPLOY needs a real executor (see sharedVm); without the vendored VM this
    // leg is skipped and tests (5)/(6) report pending instead of a false red.
    if (sharedVm()) {
        await deployChunkedContract(nodes.A,    [0, 1, 2], util);
        await deployChunkedContract(nodes.Bbtc, [2, 0, 1], util);
        nodes.contractLegRan = true;
    }
}

/**
 * Register the calling block's before(): skip without a reachable database,
 * otherwise await the one shared build. Returns the nodes object, whose fields
 * are filled once that before() has run.
 */
function useRecoveredNodes() {
    before(async function () {
        if (DB_PASS === undefined) { this.skip(); return; }
        if (!(await (reachable = reachable || dbReachable()))) { this.skip(); return; }
        await (built = built || buildNodes());
    });
    return nodes;
}

/** Close the VM and every node pool, then drop the three databases; a no-op when nothing was built. */
async function teardownRecoveredNodes() {
    if (!built) return;
    await shutdownVm();
    for (const db of [nodes.A, nodes.Bbtc, nodes.Bdoge]) { if (db && db.pool) { try { await db.pool.end(); } catch (e) {} } }
    try { const a = await admin(); for (const n of ALL_DBS) await a.query('DROP DATABASE IF EXISTS ' + n); await a.end(); } catch (e) {}
}

module.exports = {
    util, CHAIN, STAKE_SOURCE, EARN_BLOCK, COLLECT_BLOCK,
    indexMapChecksum, rewardRows, useRecoveredNodes, teardownRecoveredNodes,
};
