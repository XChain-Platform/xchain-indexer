'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// AnchorRecovery archived rewards: anchor-publish rewards restored into the BTC
// indexer's staging table at the frozen amounts a live node credits, and the
// per-batch transaction that keeps a failed batch from leaving any row behind.
// Part of the suite whose entry is test/unit/recovery.test.js.

process.env.INDEXER_COIN = 'DOGE';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');

const AnchorRecovery = require('../../../../bin/recovery.js');

// Publisher-faithful archive builder and the database stubs, shared with the
// suite entry test/unit/recovery.test.js.
const { makeKeypair, buildBatch, rawMatch, SNAPSHOT_BLOCK } = require('../../../fixtures/anchor-archive.js');
const { util, memDb, rewardBtcDbStub } = require('../../../helpers/recovery_stubs.js');

// Fresh federation keys for every test. Held at module scope so the fixture
// builders in this file read the current test's keys, exactly as they did when
// the whole suite was one describe block.
let oracleKeys, crossKeys;
function freshKeys() {
    oracleKeys = [makeKeypair(), makeKeypair(), makeKeypair(), makeKeypair()];
    crossKeys  = [makeKeypair(), makeKeypair(), makeKeypair(), makeKeypair()];
}
const quiet = { log: () => {}, util };

function reward(overrides) {
    return Object.assign({
        validator_pubkey: 'a'.repeat(64), source: '1StakeAddr',
        round_number: 7, reward_type: 'anchor_BTC',
        amount: '10.00000000', block_index: SNAPSHOT_BLOCK
    }, overrides || {});
}

describe('AnchorRecovery (full-parse recovery) @regression @tier2', function () {
    beforeEach(freshKeys);

    // ── Anchor-publish reward restore (BTC indexer DB) ──────────────────────
    describe('archived rewards', function () {
        it('restores archived anchor rewards into the BTC indexer DB', async function () {
            let { v1 } = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys,
                                    { rewards: [reward(), reward({ reward_type: 'anchor_archive', round_number: 3 })] });
            let btcDb = rewardBtcDbStub();
            let report = await new AnchorRecovery(memDb([v1], []), Object.assign({ btcDb }, quiet)).run();
            assert.strictEqual(report.verified, 1);
            assert.strictEqual(report.rewards, 2);
            assert.strictEqual(btcDb.rewards.length, 2);
            assert.strictEqual(btcDb.rewards[0].reward_type, 'anchor_BTC');
            assert.strictEqual(btcDb.rewards[0].amount, '10.00000000');
            // Staged by RAW source-address string (no id), to be materialized under the
            // deterministic source_id by the reindex apply hook.
            assert.strictEqual(btcDb.rewards[0].source_address, '1StakeAddr');
        });

        it('pins an inflated anchor_<chain> reward to the frozen constant (recovered==live, REC-REWARD-AMT-1)', async function () {
            // A colluding oracle_publish quorum (or, without --verify-stakes, a fabricated
            // archive) claims an inflated anchor_BTC amount. The batch still verifies (the
            // wrapper sigs are valid over the CRC-bound JSON), but recovery must STAGE the
            // FROZEN ANCHOR_REWARD_AMOUNT the live indexer credits (anchor.js), never the wire
            // amount, or the recovered COLLECT rail over-credits vs a live node.
            let { v1 } = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys,
                                    { rewards: [ reward({ amount: '999.00000000' }),
                                                 reward({ reward_type: 'anchor_archive', round_number: 3, amount: '999.00000000' }) ] });
            let btcDb = rewardBtcDbStub();
            let report = await new AnchorRecovery(memDb([v1], []), Object.assign({ btcDb }, quiet)).run();
            assert.strictEqual(report.verified, 1);
            let byType = Object.fromEntries(btcDb.rewards.map(r => [r.reward_type, r]));
            // anchor_BTC is v4/v5-derived at/above the flag: pinned to the frozen constant.
            assert.strictEqual(byType['anchor_BTC'].amount, '10.00000000');
            // anchor_archive is v6-derived at/above ITS flag-day (genesis on regtest), so it is
            // pinned to the frozen ARCHIVE constant for the same recovered==live reason.
            assert.strictEqual(byType['anchor_archive'].amount, '10.00000000');
        });
    });
});

describe('AnchorRecovery (full-parse recovery) @regression @tier2', function () {
    beforeEach(freshKeys);

    describe('archived rewards', function () {
        it('keeps the archived anchor_archive amount below the ARCHIVE_REWARD flag-day (legacy push era)', async function () {
            // Below the archive flag-day the reward was genuinely operator-tunable and
            // hub-pushed, so the archived amount IS what live nodes credited; pinning
            // it would fork the other way.
            let arMod = require('../../../../src/consensus/gates/anchor_reward_gate.js');
            let saved = arMod.ARCHIVE_REWARD_ACTIVATION.regtest;
            arMod.ARCHIVE_REWARD_ACTIVATION.regtest = 999999999;           // pin the flag-day dormant
            try {
                let { v1 } = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys,
                                        { rewards: [ reward({ reward_type: 'anchor_archive', round_number: 3, amount: '2.50000000' }) ] });
                let btcDb = rewardBtcDbStub();
                let report = await new AnchorRecovery(memDb([v1], []), Object.assign({ btcDb }, quiet)).run();
                assert.strictEqual(report.verified, 1);
                assert.strictEqual(btcDb.rewards[0].amount, '2.50000000');
            } finally { arMod.ARCHIVE_REWARD_ACTIVATION.regtest = saved; }
        });
    });
});

describe('AnchorRecovery (full-parse recovery) @regression @tier2', function () {
    beforeEach(freshKeys);

    describe('archived rewards', function () {
        it('rejects an archive claiming a derived reward type (oracle_round must never ride the archive)', async function () {
            let { v1 } = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys,
                                    { rewards: [reward({ reward_type: 'oracle_round' })] });
            let report = await new AnchorRecovery(memDb([v1], []), Object.assign({ btcDb: rewardBtcDbStub() }, quiet)).run();
            assert.strictEqual(report.verified, 0);
            assert.ok(report.failed[0].reason.includes('only anchor publish rewards are archivable'));
        });

        it('fails the batch when rewards are present but no BTC DB handle was provided', async function () {
            let { v1 } = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys, { rewards: [reward()] });
            let db = memDb([v1], []);
            let report = await new AnchorRecovery(db, quiet).run();
            assert.strictEqual(report.verified, 0);
            assert.ok(report.failed[0].reason.includes('no BTC indexer DB handle'));
            // The guard is hoisted ahead of every write, so the batch leaves nothing
            // behind, rather than firing only after the match rows are already committed.
            assert.strictEqual(db.matches.length, 0, 'a batch that cannot restore its rewards writes nothing');
            assert.strictEqual(db.snapshots.length, 0);
            assert.strictEqual(report.matches, 0, 'the report never counts rows the batch did not land');
        });

        it('a mid-batch write failure rolls the WHOLE batch back, on both handles (#3213)', async function () {
            // The batch verifies, so the rebuild starts writing: snapshots, matches, then the
            // reward staging - where the second row hits a DB error. Before the per-batch
            // transaction, the first reward row plus every match and snapshot of the batch
            // stayed committed while run() reported the batch FAILED, so a re-run re-staged
            // the reward that HAD landed (recovery_pending_rewards has no unique key to
            // dedupe it) and double-credited the COLLECT rail.
            let { v1 } = buildBatch(0, [rawMatch('m1'), rawMatch('m2')], oracleKeys, crossKeys,
                                    { rewards: [reward(), reward({ round_number: 8 })] });
            let db    = memDb([v1], []);
            let btcDb = rewardBtcDbStub({ failOnRewardIndex: 1 });
            let report = await new AnchorRecovery(db, Object.assign({ btcDb }, quiet)).run();

            assert.strictEqual(report.verified, 0);
            assert.strictEqual(report.failed.length, 1);
            assert.ok(report.failed[0].reason.includes('ER_LOCK_DEADLOCK'));
            assert.strictEqual(db.matches.length, 0, 'match rows rolled back');
            assert.strictEqual(db.snapshots.length, 0, 'snapshot rows rolled back');
            assert.strictEqual(btcDb.rewards.length, 0, 'the reward row that HAD landed is rolled back too');
            assert.strictEqual(db.rollbacks, 1);
            assert.strictEqual(btcDb.rollbacks, 1);
            assert.strictEqual(db.commits, 0, 'nothing may commit on a failed batch');
            assert.strictEqual(btcDb.commits, 0);
            assert.strictEqual(report.rewards, 0, 'the report never counts rolled-back rows');
        });
    });
});

describe('AnchorRecovery (full-parse recovery) @regression @tier2', function () {
    beforeEach(freshKeys);

    describe('archived rewards', function () {
        it('one failing batch does not roll back the batches that already committed (#3213)', async function () {
            // Per-BATCH atomicity, not per-run: an operator re-runs recovery after fixing the
            // cause, and every batch that already landed must stay landed (its writes are
            // idempotent on replay).
            let good = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys, { rewards: [reward()] });
            let bad  = buildBatch(1, [rawMatch('m2')], oracleKeys, crossKeys, { rewards: [reward({ round_number: 8 })] });
            let db    = memDb([good.v1, bad.v1], []);
            let btcDb = rewardBtcDbStub({ failOnRewardIndex: 1 });
            let report = await new AnchorRecovery(db, Object.assign({ btcDb }, quiet)).run();

            assert.strictEqual(report.verified, 1);
            assert.strictEqual(report.failed.length, 1);
            assert.deepStrictEqual(db.matches.map(m => m.match_id), ['m1'], 'batch 0 stays committed');
            assert.strictEqual(btcDb.rewards.length, 1);
            assert.strictEqual(db.commits, 1);
            assert.strictEqual(btcDb.commits, 1);
            assert.strictEqual(report.matches, 1);
            assert.strictEqual(report.rewards, 1);
        });

        it('the DOGE mirror commits BEFORE the reward staging (crash-window ordering, #3213)', async function () {
            // MariaDB has no cross-database atomic commit, so the window between the two
            // commits is made harmless by ORDER: the idempotent handle (matches/calls/
            // snapshots) commits first and the NON-idempotent reward staging second. A crash
            // in between rolls the rewards back, and the re-run stages them exactly once.
            // The reverse order would leave rewards staged under a FAILED batch and
            // double-credit on the re-run.
            let seq = [];
            let { v1 } = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys, { rewards: [reward()] });
            let db    = memDb([v1], []);
            let btcDb = rewardBtcDbStub();
            let dogeCommit = db.commitTransaction.bind(db);
            let btcCommit  = btcDb.commitTransaction.bind(btcDb);
            db.commitTransaction    = async () => { seq.push('doge'); return dogeCommit(); };
            btcDb.commitTransaction = async () => { seq.push('btc');  return btcCommit(); };

            let report = await new AnchorRecovery(db, Object.assign({ btcDb }, quiet)).run();
            assert.strictEqual(report.verified, 1);
            assert.deepStrictEqual(seq, ['doge', 'btc']);
        });
    });
});

describe('AnchorRecovery (full-parse recovery) @regression @tier2', function () {
    beforeEach(freshKeys);

    describe('archived rewards', function () {
        it('a failing second begin does not strand the first transaction (#3213)', async function () {
            // The DOGE transaction is already open when the BTC handle refuses to start one.
            // Leaving it open would hold Database's transaction mutex and hang the NEXT
            // batch's beginTransaction forever, so the batch must unwind what it opened.
            let { v1 } = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys, { rewards: [reward()] });
            let db    = memDb([v1], []);
            let btcDb = rewardBtcDbStub();
            btcDb.beginTransaction = async () => { throw new Error('ER_CON_COUNT_ERROR: too many connections'); };
            let report = await new AnchorRecovery(db, Object.assign({ btcDb }, quiet)).run();

            assert.strictEqual(report.verified, 0);
            assert.ok(report.failed[0].reason.includes('ER_CON_COUNT_ERROR'));
            assert.strictEqual(db.txDepth, 0, 'the DOGE transaction must not be left open');
            assert.strictEqual(db.rollbacks, 1);
            assert.strictEqual(db.matches.length, 0);
        });
    });
});

describe('AnchorRecovery (full-parse recovery) @regression @tier2', function () {
    beforeEach(freshKeys);

    describe('archived rewards', function () {
        it('a raw query handle with no transaction API still rebuilds (back-compat)', async function () {
            // Recovery is also driven by plain doQuery handles (embedders, fixtures). Those
            // keep the pre-#3213 autocommit behavior rather than throwing on beginTransaction.
            let { v1 } = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys, { rewards: [reward()] });
            let db     = memDb([v1], [], { noTx: true });
            let btcDb  = rewardBtcDbStub({ noTx: true });
            let report = await new AnchorRecovery(db, Object.assign({ btcDb }, quiet)).run();

            assert.strictEqual(report.verified, 1);
            assert.strictEqual(db.matches.length, 1);
            assert.strictEqual(btcDb.rewards.length, 1);
        });

        it('rejects a reward row missing its earn-time source', async function () {
            let { v1 } = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys, { rewards: [reward({ source: '' })] });
            let report = await new AnchorRecovery(memDb([v1], []), Object.assign({ btcDb: rewardBtcDbStub() }, quiet)).run();
            assert.strictEqual(report.verified, 0);
            assert.ok(report.failed[0].reason.includes('earn-time source'));
        });
    });
});
