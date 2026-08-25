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
 * test/integration/anchor-reward-round-qualifier.test.js
 *
 * Runs the ARCHIVE reward's ledger key against a REAL MariaDB.
 *
 * The archive reward's round_reference is MATCH_BATCH_SEQ, a dense counter the hub
 * allocates from its own tables, and those tables are reset by a wipe-and-replay
 * rebase - so after a rebase the hub reissues seq values earlier archive batches
 * already used, and two genuinely distinct archive anchors present the same round.
 * The signed side always told them apart (the XANCPUB canonical and
 * anchor_reward_attestations.uq_reward_tuple both carry snapshot_block); the ledger
 * key and the reconcile predicate did not, so one real quorum-attested publisher was
 * paid nothing.
 *
 * Why this has to be a DB-backed tier, for the reasons its late-publisher sibling
 * states and one more:
 *
 *   - the defect lives in a UNIQUE INDEX and two raw SQL predicates. A stubbed
 *     doQuery can assert their SHAPE but can never say whether MariaDB actually
 *     treats two rows as one, which is the entire question here.
 *   - doQuery() SWALLOWS a non-transactional query error, so a predicate that
 *     referenced a column the schema does not have would look green in the unit
 *     tier while deriving no archive rewards at all on a live node.
 *   - the UNIQUE key is the half nothing else converges: reconcileTableIndexes
 *     refuses to rebuild an index whose name is already taken, so only the dated
 *     migration changes it on an aged database. Driving the real index is the only
 *     way to know the declared shape does what the fix claims.
 *
 * Self-skips when TEST_DB_PASS is unset, matching the other DB-backed files here.
 * Run it with bin/run-db-tiers.sh.
 */

'use strict';

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert  = require('assert');
const fs      = require('fs');
const path    = require('path');
const mariadb = require('mariadb');

const { getTestConfig } = require('../fixtures/config');
const Utility  = require('../../src/utility');
const Database = require('../../src/db');
const arKey    = require('../../src/anchor_reward_key');

const DB_HOST = process.env.TEST_DB_HOST || '127.0.0.1';
const DB_PORT = parseInt(process.env.TEST_DB_PORT) || 3306;
const DB_USER = process.env.TEST_DB_USER || 'root';
const DB_PASS = process.env.TEST_DB_PASS;            // undefined => self-skip
const DB_NAME = process.env.TEST_ANCHOR_QUALIFIER_DB || 'xchain_anchor_reward_qualifier';

const SQL_DIR = path.join(__dirname, '../../src/sql');
// Strip `--` line comments with the PRODUCT's own stripper: the licence banner starts
// `--***` with no whitespace, which MySQL does not treat as a comment, so a verbatim
// send is errno 1064 on the first line.
const stripSqlLineComments = Database.prototype.stripSqlLineComments;
const SCHEMA = ['index_pubkeys.sql', 'validator_rewards.sql',
                'anchor_reward_attestations.sql', 'anchor_reward_reconcile_log.sql']
    .map(f => stripSqlLineComments(fs.readFileSync(path.join(SQL_DIR, f), 'utf8')))
    .join('\n');

// Two publishers, as a failover double-publish produces. SMALL sorts lexicographically
// below LARGE, so SMALL is the fleet-wide winner whichever order they arrive in.
const PK_SMALL = '0a'.repeat(32);
const PK_LARGE = 'f0'.repeat(32);
const SOURCE   = 1;                                  // staking address; irrelevant to these predicates
const AMOUNT   = '10.00000000';

// One reissued archive round: the same MATCH_BATCH_SEQ on two different snapshots.
const ROUND    = 4174;
const SNAP_OLD = 8100;                               // the pre-rebase archive batch
const SNAP_NEW = 9200;                               // the post-rebase batch that reused the seq

describe('archive reward round_qualifier against a real MariaDB @tier3', function () {
    this.timeout(60000);

    let db, pubkeyId = {};

    before(async function () {
        if (!DB_PASS) this.skip();
        const admin = await mariadb.createConnection({
            host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASS, multipleStatements: true });
        await admin.query('DROP DATABASE IF EXISTS ' + DB_NAME + '; CREATE DATABASE ' + DB_NAME + ';');
        await admin.query('USE ' + DB_NAME + '; ' + SCHEMA);
        await admin.end();

        db = makeDb();
        const c = await db.getConnection();
        try {
            for (const pk of [PK_LARGE, PK_SMALL])
                await c.query('INSERT INTO index_pubkeys (pubkey) VALUES (?)', [pk]);
            for (const r of await c.query('SELECT id, pubkey FROM index_pubkeys'))
                pubkeyId[r.pubkey] = Number(r.id);
        } finally { await c.release(); }
    });

    after(async function () {
        if (db && db.pool) await db.pool.end();
    });

    beforeEach(reset);

    function makeDb() {
        const config = getTestConfig();
        const util   = new Utility();
        return new Database(DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASS, { config, util });
    }

    async function conn(fn) {
        const c = await db.getConnection();
        try { return await fn(c); } finally { await c.release(); }
    }

    async function reset() {
        await conn(async c => {
            for (const t of ['anchor_reward_attestations', 'validator_rewards',
                             'anchor_reward_reconcile_log'])
                await c.query('DELETE FROM ' + t);
        });
    }

    /** Mirror one hub-authored attestation in, as hub_db_sync does. */
    function attest(rewardType, round, snapshotBlock, publisher) {
        return conn(c => c.query(
            `INSERT INTO anchor_reward_attestations
                 (chain, network, reward_type, round_reference, snapshot_block,
                  publisher, reward_amount, publisher_attestations)
             VALUES ('BTC', 'regtest', ?, ?, ?, ?, ?, '[]')`,
            [rewardType, round, snapshotBlock, publisher, AMOUNT]));
    }

    /**
     * Credit the derived reward the way createValidatorReward does at/above the derive
     * gate: the same column list, the same upsert, and block_index = the earn block
     * (snapshot_block). The stake-source resolution createValidatorReward does first is
     * not what is under test here, so this writes the row directly.
     */
    function credit(publisher, rewardType, round, snapshotBlock) {
        const qualifier = arKey.rewardRoundQualifier(rewardType, snapshotBlock);
        return conn(c => c.query(
            `INSERT INTO validator_rewards
                 (source_id, signing_pubkey_id, reward_type, round_reference, round_qualifier,
                  amount, block_index)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE amount=VALUES(amount), block_index=VALUES(block_index)`,
            [SOURCE, pubkeyId[publisher], rewardType, round, qualifier, AMOUNT, snapshotBlock]));
    }

    /** Every (pubkey, qualifier) currently credited for a reward type + round. */
    async function credited(rewardType, round) {
        const rows = await conn(c => c.query(
            `SELECT pk.pubkey AS pubkey, vr.round_qualifier AS q, vr.block_index AS b
               FROM validator_rewards vr
               JOIN index_pubkeys pk ON pk.id = vr.signing_pubkey_id
              WHERE vr.reward_type = ? AND vr.round_reference = ?
              ORDER BY vr.round_qualifier, pk.pubkey`, [rewardType, round]));
        return rows.map(r => ({ pubkey: r.pubkey, qualifier: Number(r.q), block: Number(r.b) }));
    }

    /**
     * What a COLLECT at `blockIndex` would credit this staking source. The same scoped
     * SUM getUnclaimedRewardTotal issues (source_id + block_index <= B), which is the
     * value the whole defect was leaking.
     */
    async function collectSum(blockIndex) {
        const rows = await conn(c => c.query(
            `SELECT COALESCE(SUM(CAST(amount AS DECIMAL(65,18))), 0) AS total
               FROM validator_rewards WHERE source_id = ? AND block_index <= ?`,
            [SOURCE, blockIndex]));
        return Number(rows[0].total);
    }

    // ── (a) two real archive anchors sharing a reissued seq ──────────────────────────

    it('keeps BOTH archive rewards when one reissued seq covers two snapshots, and COLLECT sees both', async function () {
        // Two genuinely distinct archive anchors: same MATCH_BATCH_SEQ (the hub's counter
        // restarted), different snapshot blocks, different elected publishers. Each has its
        // own 2f+1 XANCPUB quorum, so each is owed its own reward.
        await credit(PK_LARGE, 'anchor_archive', ROUND, SNAP_OLD);
        await credit(PK_SMALL, 'anchor_archive', ROUND, SNAP_NEW);

        // Each snapshot reconciles as its OWN single-winner group. Neither call may reach
        // across into the other's row: that reach is the defect.
        await db.reconcileAnchorRewardWinner(ROUND, 'anchor_archive', SNAP_OLD + 1, null, SNAP_OLD);
        await db.reconcileAnchorRewardWinner(ROUND, 'anchor_archive', SNAP_NEW + 1, null, SNAP_NEW);

        assert.deepStrictEqual(await credited('anchor_archive', ROUND), [
            { pubkey: PK_LARGE, qualifier: SNAP_OLD, block: SNAP_OLD },
            { pubkey: PK_SMALL, qualifier: SNAP_NEW, block: SNAP_NEW },
        ], 'both quorum-attested archive anchors must still be paid');

        // The value half. Unqualified, PK_SMALL would have deleted PK_LARGE's row (it sorts
        // below it) and the COLLECT rail would conserve one reward for two real publishes.
        assert.strictEqual(await collectSum(SNAP_NEW), 20,
            'COLLECT must see both rewards, not one');
        assert.strictEqual(await conn(c => c.query('SELECT COUNT(*) AS n FROM anchor_reward_reconcile_log'))
            .then(r => Number(r[0].n)), 0, 'neither reconcile may pre-image a loser: there is no loser');
    });

    it('does not let the UNIQUE key merge two archive rewards that differ only in snapshot_block', async function () {
        // The schema half, driven directly. The same publisher can win the archive election
        // on both sides of a rebase; under the four-column key the second publish upserted
        // onto the first row (overwriting its earn-block) and earned nothing extra.
        await credit(PK_SMALL, 'anchor_archive', ROUND, SNAP_OLD);
        await credit(PK_SMALL, 'anchor_archive', ROUND, SNAP_NEW);

        assert.deepStrictEqual(await credited('anchor_archive', ROUND), [
            { pubkey: PK_SMALL, qualifier: SNAP_OLD, block: SNAP_OLD },
            { pubkey: PK_SMALL, qualifier: SNAP_NEW, block: SNAP_NEW },
        ], 'one publisher, two archive anchors, two rewards');
        assert.strictEqual(await collectSum(SNAP_NEW), 20);
    });

    it('re-admits the second snapshot through the pending-attestation gate (it was suppressed outright)', async function () {
        // The worst leg of the defect: the NOT EXISTS matched on (reward_type,
        // round_reference) alone, so once ANY publisher of the reissued seq was derived, the
        // other snapshot's attestation was excluded forever - never inserted, never
        // reconciled, never paid, with no late-publisher path to heal it.
        await attest('anchor_archive', ROUND, SNAP_OLD, PK_SMALL);
        await attest('anchor_archive', ROUND, SNAP_NEW, PK_LARGE);

        const first = await db.getPendingAnchorRewardAttestations('regtest', SNAP_NEW);
        assert.deepStrictEqual(first.map(r => Number(r.snapshot_block)).sort((a, b) => a - b),
            [SNAP_OLD, SNAP_NEW], 'both snapshots are pending before anything is derived');

        // Derive the SMALL publisher's (older) snapshot only, as a node whose mirror carried
        // that row first would.
        await credit(PK_SMALL, 'anchor_archive', ROUND, SNAP_OLD);
        await db.reconcileAnchorRewardWinner(ROUND, 'anchor_archive', SNAP_OLD + 1, null, SNAP_OLD);

        const second = await db.getPendingAnchorRewardAttestations('regtest', SNAP_NEW);
        assert.deepStrictEqual(second.map(r => Number(r.snapshot_block)), [SNAP_NEW],
            'the other snapshot must still be pending; deriving one seq must not swallow the other');
        assert.deepStrictEqual(second.map(r => r.publisher), [PK_LARGE]);
    });

    // ── (b) the genuine failover case still collapses ────────────────────────────────

    it('still collapses a real failover double-publish (same round AND same snapshot) to the smallest pubkey', async function () {
        // Same archive anchor, two publishers - the failover the single-winner rule exists
        // for. This must be UNCHANGED by the qualifier: one logical anchor, one reward.
        await credit(PK_LARGE, 'anchor_archive', ROUND, SNAP_OLD);
        await credit(PK_SMALL, 'anchor_archive', ROUND, SNAP_OLD);

        const removed = await db.reconcileAnchorRewardWinner(ROUND, 'anchor_archive', SNAP_OLD + 1, 7, SNAP_OLD);
        assert.strictEqual(removed, 1, 'exactly the larger pubkey is retracted');
        assert.deepStrictEqual(await credited('anchor_archive', ROUND), [
            { pubkey: PK_SMALL, qualifier: SNAP_OLD, block: SNAP_OLD },
        ]);
        assert.strictEqual(await collectSum(SNAP_NEW), 10, 'one anchor pays one reward');

        // The loser is pre-imaged WITH its qualifier, or the reorg restore would re-INSERT a
        // different row than the one deleted.
        const log = await conn(c => c.query(
            'SELECT round_reference, round_qualifier, signing_pubkey_id FROM anchor_reward_reconcile_log'));
        assert.strictEqual(log.length, 1);
        assert.strictEqual(Number(log[0].round_reference), ROUND);
        assert.strictEqual(Number(log[0].round_qualifier), SNAP_OLD);
        assert.strictEqual(Number(log[0].signing_pubkey_id), pubkeyId[PK_LARGE]);
    });

    it('a reconcile for one snapshot never retracts the other snapshot winner', async function () {
        // The cross-snapshot reach, isolated: three rows, one reconcile, and the row it must
        // not touch is the one that sorts smallest overall.
        await credit(PK_LARGE, 'anchor_archive', ROUND, SNAP_OLD);
        await credit(PK_SMALL, 'anchor_archive', ROUND, SNAP_NEW);

        const removed = await db.reconcileAnchorRewardWinner(ROUND, 'anchor_archive', SNAP_OLD + 1, null, SNAP_OLD);
        assert.strictEqual(removed, 0, 'the old snapshot has a single publisher, so nothing is a loser');
        assert.strictEqual((await credited('anchor_archive', ROUND)).length, 2);
    });

    // ── (c) every non-archive reward is untouched ────────────────────────────────────

    for (const type of ['anchor_BTC', 'anchor_LTC', 'anchor_DOGE']) {
        it('stores qualifier 0 for ' + type + ' and reconciles it exactly as before', async function () {
            // The per-chain legs key on CHECKPOINT_SEQ == snapshot_block, a height that only
            // advances, so they are never qualified and their behavior must be byte-identical.
            assert.strictEqual(arKey.rewardRoundQualifier(type, SNAP_OLD), 0);

            await credit(PK_LARGE, type, SNAP_OLD, SNAP_OLD);
            await credit(PK_SMALL, type, SNAP_OLD, SNAP_OLD);
            assert.deepStrictEqual((await credited(type, SNAP_OLD)).map(r => r.qualifier), [0, 0]);

            // Called the legacy 4-argument way, exactly as api.js's push path still does.
            const removed = await db.reconcileAnchorRewardWinner(SNAP_OLD, type, SNAP_OLD + 1, null);
            assert.strictEqual(removed, 1);
            assert.deepStrictEqual(await credited(type, SNAP_OLD), [
                { pubkey: PK_SMALL, qualifier: 0, block: SNAP_OLD },
            ]);
        });
    }

    it('leaves a per-chain leg pending exactly as before (the qualifier adds no exclusion)', async function () {
        await attest('anchor_BTC', SNAP_OLD, SNAP_OLD, PK_LARGE);
        await attest('anchor_BTC', SNAP_OLD, SNAP_OLD, PK_SMALL);

        assert.strictEqual((await db.getPendingAnchorRewardAttestations('regtest', SNAP_NEW)).length, 2);

        // Deriving the SMALLEST pubkey settles the round: the publisher-scoped exclusion
        // keeps the larger one out, and the qualifier (0 on both sides) changes nothing.
        await credit(PK_SMALL, 'anchor_BTC', SNAP_OLD, SNAP_OLD);
        assert.deepStrictEqual(await db.getPendingAnchorRewardAttestations('regtest', SNAP_NEW), []);
    });
});
