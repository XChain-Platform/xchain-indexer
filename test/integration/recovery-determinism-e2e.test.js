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
 * test/integration/** glob, which provides the DB service.
 *
 ********************************************************************/
'use strict';

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert  = require('assert');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');
const mariadb = require('mariadb');

const { getTestConfig } = require('../fixtures/config');
const { makeKeypair, buildBatch, rawMatch } = require('../fixtures/anchor-archive.js');
const Utility        = require('../../src/utility');
const Database       = require('../../src/db');
const AnchorRecovery = require('../../src/recovery.js');
const Deploy         = require('../../src/actions/deploy.js');
const Mapper         = require('../../src/mapper.js');
const { buildStateHashData, INDEX_MAP_STATE_HASH_ACTIVATION } = require('../../src/stateHash');

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
const ar            = require('../../src/anchor_reward_activation');
const REWARD_AMOUNT = ar.ANCHOR_REWARD_AMOUNT;
const FORGED_ARCHIVE_AMOUNT = '5.00000000';
const REWARD_ROUND  = 1;
const REWARD_TYPE   = 'anchor_BTC';

const VALIDATOR = makeKeypair();   // the reward's signing validator (independent of federation signers)

// The DOGE address that publishes the seeded archive anchor: head and every continuation
// chunk are authored by it, which is what binds the chunks to the head since #3075.
const ARCHIVE_PUBLISHER = 'DArchivePublisher0000000000000000';

// ── Contract-heavy recovery leg ────────────────────────────────────
// The launch bundle deploys contracts via chunked DEPLOY: a run of v4 carriers each
// carrying one ordered base64 slice of the source, then a v2/v3 that reassembles the
// slices (keyed on CODE_HASH), sha256-verifies, and creates the contract. This leg
// re-confirms that a contract-heavy chain reindexes byte-identically across the recovery
// boundary: node A deploys it from-genesis, node B deploys the SAME contract after the
// real AnchorRecovery pre-seed, and their `contracts` + `deploy_chunks` rows must match
// row-for-row - including source_id, which is an index_addresses id (the F1a determinism
// guarantee that recovery's out-of-band pre-seed does not offset the id map, now proven to
// carry through to a contract's on-chain deployer binding). Node B records its carriers in a
// DIFFERENT physical order than node A, so the match also pins the assembler's
// ORDER BY chunk_index, action_index against a real engine (delivery-order independence).
const CONTRACT_DEPLOYER = 'btc1qAaa';   // created in CHAIN block 1 (has a deterministic id on both nodes)
const CONTRACT_BLOCK    = 5;            // after EARN/COLLECT so the deploy never perturbs the reward assertions
const CONTRACT_CODE     = 'module.exports = { run: function(state, params) { return { value: 42 }; } };'
                        + ' // chunked-DEPLOY recovery byte-identity regression: padded to force a multi-slice base64 body split across v4 carriers';
const CONTRACT_HASH     = crypto.createHash('sha256').update(Buffer.from(CONTRACT_CODE, 'utf8')).digest('hex');
const CONTRACT_CHUNKS   = 3;
// Carrier action indices, one per chunk position, all below the assembling DEPLOY's index
// so getDeployChunksForAssembly consumes them. Keyed by position, NOT by insertion order.
const CARRIER_INDEX     = { 0: 5001, 1: 5002, 2: 5003 };
const ASSEMBLE_INDEX    = 5010;

// The REAL xchain-vm, built once and shared by both nodes' DEPLOY handlers.
//
// This fixture used to pass `vm: null` on the theory that the chunked-assembly + code_hash
// path never runs VM code. That was true of the v4 CARRIERS (deploy.js delegates them to
// DeployChunk before any VM work) but never of the v2 ASSEMBLY, and it stopped being
// survivable when deploy.js gained its fail-CLOSED guard: a DEPLOY reaching the shared
// validation path with no executor now throws EXECUTOR_UNAVAILABLE rather than skipping the
// syntax/manifest gate, because a VM-less node that recorded such a deploy VALID would fork
// the ledger against the rest of the fleet. So the fixture needs a real executor; the
// product is correct and it is this fixture that was stale.
//
// Only the syntax + manifest gates actually run here: CONSTRUCTOR_PARAMS is empty on the
// assembling DEPLOY, so runConstructor is false and no contract code executes.
let vmInstance;
let vmLoadFailed = false;
function sharedVm() {
    if (vmInstance || vmLoadFailed) return vmInstance || null;
    try {
        const XChainVM = require('xchain-vm');
        // Same subprocess executor the indexer runs in production (src/actions.js), so the
        // gates this fixture drives are the ones a real node applies.
        vmInstance = new XChainVM({
            execution:   'subprocess',
            gasSchedule: getTestConfig()['GAS_SCHEDULE'],
            gasCeiling:  1000000,
            limits:      { maxCpuTimeMs: 30000, maxMemory: 8, maxEmissions: 50,
                           maxStateKeys: 10000, maxStateValueSize: 65536,
                           maxCodeSize: Deploy.MAX_CODE_SIZE },
        });
    } catch (e) {
        // xchain-vm is a file: dependency whose vendored directory is untracked, so a tree
        // assembled without it cannot run this leg. Skip that leg loudly rather than
        // reporting a venue gap as a consensus failure (the trap records twice)
        // bin/run-db-tiers.sh refuses to start a tier at all in that state.
        vmLoadFailed = true;
        console.log('WARNING: xchain-vm unavailable; SKIPPING the chunked-DEPLOY recovery leg ' +
                    '(tests 5/6). This is a VENUE gap, not a passing consensus check: ' + e.message);
    }
    return vmInstance || null;
}

// A DEPLOY handler bound to one real indexer DB. GAS_PRICE '0' (fee 0 -> the balance/
// native-fee legs are skipped, so no gas token needs seeding); protocolChanges is stubbed
// enabled because this regtest node is genesis-active for every DEPLOY gate. This drives the
// REAL Deploy / DeployChunk handlers so the assertions cover the shipped assembler, not a
// reimplementation.
function makeDeployHandler(db) {
    const config = getTestConfig();
    config['GAS_PRICE'] = '0';
    const mapper = new Mapper({ config, decoderDb: db, indexerDb: db, util });
    const action = { config, decoderDb: db, indexerDb: db, util, mapper,
                     protocolChanges: { isEnabled: async () => true }, vm: sharedVm() };
    return new Deploy(action);
}

// Deploy the chunked contract on `db`: record the CONTRACT_CHUNKS v4 carriers (in `insertOrder`,
// a permutation of the positions) then run the v2 assembly. Wrapped in one block transaction,
// mirroring how the indexer processes a block.
async function deployChunkedContract(db, insertOrder) {
    const handler = makeDeployHandler(db);
    const b64  = Buffer.from(CONTRACT_CODE, 'utf8').toString('base64');
    const size = Math.ceil(b64.length / CONTRACT_CHUNKS);
    const slice = (i) => b64.slice(i * size, (i + 1) * size);
    await db.beginTransaction();
    db.blockIndex = CONTRACT_BLOCK;
    for (const pos of insertOrder) {
        util.resetLists();
        const data = { ACTION: 'DEPLOY', SOURCE: CONTRACT_DEPLOYER, BLOCK_INDEX: CONTRACT_BLOCK,
                       BLOCK_TIME: 1700000000, TX_HASH: 'aa'.repeat(32), TX_INDEX: 0, TX_VOUT: 0,
                       FORMAT: 4, ACTION_INDEX: CARRIER_INDEX[pos] };
        await handler.parse(['4', CONTRACT_HASH, String(pos), String(CONTRACT_CHUNKS), slice(pos)], data, null);
        assert.strictEqual(data['STATUS'], 'valid', 'v4 carrier ' + pos + ' must store valid: ' + data['STATUS']);
    }
    util.resetLists();
    const data = { ACTION: 'DEPLOY', SOURCE: CONTRACT_DEPLOYER, BLOCK_INDEX: CONTRACT_BLOCK,
                   BLOCK_TIME: 1700000000, TX_HASH: 'aa'.repeat(32), TX_INDEX: 0, TX_VOUT: 0,
                   FORMAT: 2, ACTION_INDEX: ASSEMBLE_INDEX };
    await handler.parse(['2', CONTRACT_HASH, '100000', ''], data, null);
    assert.strictEqual(data['STATUS'], 'valid', 'v2 chunked-assembly deploy must be valid: ' + data['STATUS']);
    await db.commitTransaction();
}

// contracts rows, status resolved to its STRING (index_statuses ids are per-DB surrogates and
// NOT part of the F1a id-map guarantee, so compare by status text; source_id IS an
// index_addresses id and IS guaranteed identical, so it stays in the comparison).
async function contractRows(db) {
    const rows = await db.doQuery(
        "SELECT c.action_index, c.source_id, c.code, c.code_hash, c.api_version, s.status AS status, c.block_index " +
        "FROM contracts c JOIN index_statuses s ON s.id = c.status_id ORDER BY c.action_index");
    return rows.map(r => ({
        action_index: String(r.action_index), source_id: String(r.source_id),
        code: String(r.code), code_hash: String(r.code_hash),
        api_version: String(r.api_version), status: String(r.status), block_index: String(r.block_index),
    }));
}

async function deployChunkRows(db) {
    const rows = await db.doQuery(
        "SELECT dc.chunk_index, dc.total_chunks, dc.code_part, dc.source_id, dc.code_hash, st.status AS status " +
        "FROM deploy_chunks dc JOIN index_statuses st ON st.id = dc.status_id ORDER BY dc.chunk_index");
    return rows.map(r => ({
        chunk_index: String(r.chunk_index), total_chunks: String(r.total_chunks),
        code_part: String(r.code_part), source_id: String(r.source_id),
        code_hash: String(r.code_hash), status: String(r.status),
    }));
}

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
    // Every anchor row also needs its `actions` row (#3075): a v2 continuation chunk is
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

describe('Recovery-determinism e2e (consensus) @integration', function () {
    this.timeout(120000);
    let A, Bbtc, Bdoge;
    // Whether the contract-heavy leg actually ran (it needs the vendored xchain-vm).
    let contractLegRan = false;

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

        // Contract-heavy leg: deploy the SAME chunked contract on both nodes, across
        // the recovery boundary. Node A (from-genesis) records carriers in position order; node B
        // (recovered) records them in a DIFFERENT order, so the byte-identity below also proves
        // the assembler is independent of chunk delivery/storage order on a real engine.
        // A real DEPLOY needs a real executor (see sharedVm); without the vendored VM this
        // leg is skipped and tests (5)/(6) report pending instead of a false red.
        if (sharedVm()) {
            await deployChunkedContract(A,    [0, 1, 2]);
            await deployChunkedContract(Bbtc, [2, 0, 1]);
            contractLegRan = true;
        }
    });

    after(async function () {
        if (vmInstance) { try { await vmInstance.shutdown(); } catch (e) {} }
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

    // contract-heavy re-confirm on the chunked-DEPLOY launch bundle. The v4-carrier +
    // v2-assembly deploy must reindex byte-identically across the recovery boundary.
    it('(5) chunked-DEPLOY contract is byte-identical A vs B across the recovery boundary', async function () {
        if (!contractLegRan) return this.skip();
        const cA = await contractRows(A);
        const cB = await contractRows(Bbtc);
        assert.strictEqual(cA.length, 1, 'node A deployed exactly the one chunked contract');
        assert.deepStrictEqual(cB, cA, 'recovered node must reproduce the from-genesis contract row-for-row');
        // The stored source is the reassembled plaintext and its declared hash binds it.
        assert.strictEqual(cA[0].code, CONTRACT_CODE, 'assembled code equals the deployed source');
        assert.strictEqual(cA[0].code_hash, CONTRACT_HASH, 'code_hash is sha256 of the assembled source');
        assert.strictEqual(cA[0].status, 'valid');
        // source_id is an index_addresses id: identical only because F1a keeps the id map
        // aligned across the recovery pre-seed. Pin it to the deployer's deterministic id.
        const deployerIdA = String(await A.getAddressId(CONTRACT_DEPLOYER));
        const deployerIdB = String(await Bbtc.getAddressId(CONTRACT_DEPLOYER));
        assert.strictEqual(deployerIdB, deployerIdA, 'deployer id is identical across the recovery boundary');
        assert.strictEqual(cA[0].source_id, deployerIdA, 'contract binds the deterministic deployer id');
    });

    it('(6) deploy_chunks carriers are byte-identical A vs B despite different insert order', async function () {
        if (!contractLegRan) return this.skip();
        const kA = await deployChunkRows(A);
        const kB = await deployChunkRows(Bbtc);
        assert.strictEqual(kA.length, CONTRACT_CHUNKS, 'all v4 carriers were stored on node A');
        assert.deepStrictEqual(kB, kA, 'recovered node stores byte-identical carrier rows (order-independent)');
        // The chunk group is bound to the same deployer id and code_hash on both nodes.
        for (const row of kA) {
            assert.strictEqual(row.code_hash, CONTRACT_HASH);
            assert.strictEqual(row.status, 'valid');
        }
    });
});
