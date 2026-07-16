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

// AnchorRecovery round-trip: build an archive batch exactly as the hub's
// StateAnchorPublisher serializes it (fixed key order, gzip+base64url, CRC32,
// chunking, REAL Ed25519 signatures), feed it through a mocked anchor_actions
// table, and assert cross_chain_matches + capability_snapshots rebuild, plus
// the failure modes: CRC corruption, sub-quorum wrapper, fabricated validator
// sets (the on-chain stake cross-check), and latest-status-wins retraction.

process.env.INDEXER_COIN = 'DOGE';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');

const AnchorRecovery = require('../../src/recovery.js');
const Utility        = require('../../src/utility.js');

// Publisher-faithful archive builder shared with the recovery-determinism e2e
// (test/integration/recovery-determinism-e2e.test.js). Single source for the
// hub serialization both tests verify against.
const { makeKeypair, buildBatch, rawMatch, rawCall, SNAPSHOT_BLOCK } = require('../fixtures/anchor-archive.js');

// Stake-weighted quorum (WI-1) is active for every regtest snapshot_block
// (STAKE_WEIGHTED_QUORUM_ACTIVATION.regtest = 0), so recovery takes the weighted
// predicate, which needs the indexer's bcmath. Each archived snapshot below
// carries a DISTINCT source at equal weight, so the source-deduped threshold
// (3·Σweight > 2·S) reduces to the legacy 2f+1 signer count.
const util = new Utility();

// In-memory DOGE indexer DB for the recovery query surface.
function memDb(v1s, v2s) {
    let matches = [], snapshots = [], calls = [];
    return {
        matches, snapshots, calls,
        async doQuery(sql, params) {
            params = params || [];
            // recovery.run() now joins index_statuses and restricts to status IN
            // ('valid','unverified'), matching getMaxAnchorBatchSeq. Model that here: a fixture
            // row's optional `status` property drives the filter (absent = 'valid', so the
            // pre-existing fixtures are unaffected). A row parsed as invalid is excluded, exactly
            // as the INNER JOIN + status set drops it against the real schema.
            if (sql.startsWith('SELECT a.* FROM anchor_actions a')) {
                return v1s.filter(v => {
                    let st = (v.status == null) ? 'valid' : String(v.status);
                    return st === 'valid' || st === 'unverified';
                });
            }
            if (sql.startsWith('SELECT chunk_index, archive_b64 FROM anchor_actions WHERE version = 2'))
                return v2s.filter(c => Number(c.match_batch_seq) === Number(params[0]));
            if (sql.startsWith('INSERT IGNORE INTO capability_snapshots')) {
                let [snapshot_block, capability, signing_pubkey, amount] = params;
                if (!snapshots.some(r => r.snapshot_block === snapshot_block && r.capability === capability && r.signing_pubkey === signing_pubkey))
                    snapshots.push({ snapshot_block, capability, signing_pubkey, amount });
                return [];
            }
            if (sql.startsWith('SELECT match_id FROM cross_chain_matches'))
                return matches.filter(r => r.match_id === params[0]).map(r => ({ match_id: r.match_id }));
            if (sql.startsWith('UPDATE cross_chain_matches SET status')) {
                // params = [status, anchorTxid, match_id]; anchor_txid upgrades
                // NULL->value only (COALESCE semantics in recovery._rebuild).
                for (let r of matches) if (r.match_id === params[2]) {
                    r.status = params[0];
                    if (r.anchor_txid == null) r.anchor_txid = params[1];
                }
                return [];
            }
            if (sql.startsWith('INSERT INTO cross_chain_matches')) {
                // Positional per recovery's INSERT (no id column in these fixtures): the
                // royalty columns sit at 11 (a_payout_legs) / 20 (b_payout_legs), status at 23;
                // anchor_txid is the last param, finalizing_view second-to-last.
                matches.push({ match_id: params[0], a_payout_legs: params[11], b_payout_legs: params[20],
                               status: params[23], finalizing_view: params[params.length - 2],
                               anchor_txid: params[params.length - 1] });
                return [];
            }
            if (sql.startsWith('SELECT call_id FROM cross_chain_calls'))
                return calls.filter(r => r.call_id === params[0] && r.phase === params[1]).map(r => ({ call_id: r.call_id }));
            if (sql.startsWith('UPDATE cross_chain_calls SET status')) {
                if (sql.includes('snapshot_block')) {
                    // Finalized-wins full-column content upgrade (recovery._rebuild). Param order:
                    // [0]=status, [12]=effective_time, [15]=validator_signatures, [16]=finalizing_view,
                    // [17]=call_id, [18]=phase (mirrors the UPDATE column list).
                    for (let r of calls) if (r.call_id === params[17] && r.phase === params[18]) {
                        r.status = params[0];
                        r.effective_time = params[12];
                        r.validator_signatures = params[15];
                        r.finalizing_view = params[16];
                    }
                    return [];
                }
                // Status-only update (non-finalized incoming): params = [status, call_id, phase].
                for (let r of calls) if (r.call_id === params[1] && r.phase === params[2]) r.status = params[0];
                return [];
            }
            if (sql.startsWith('INSERT INTO cross_chain_calls')) {
                calls.push({ id: params[0], call_id: params[1], phase: params[2],
                             effective_time: params[14], status: params[15],
                             validator_signatures: params[18], finalizing_view: params[params.length - 1] });
                return [];
            }
            return [];
        }
    };
}

// BTC indexer stub: every pubkey in `staked` holds an active stake (the raw
// _verifyStakes existence query). opts.capSets = { <capability>: [{pubkey, source, weight}] }
// backs the REC-SUBSET-1 completeness resolver (getStakeWeightsByCapability /
// getValidatorsByCapability); opts.truncated = [<capability>...] flags a capped
// resolution. With no capSets the resolver returns [] (completeness is vacuous),
// so the pre-existing --verify-stakes tests are unaffected.
function btcDbStub(staked, opts) {
    opts = opts || {};
    let set = new Set(staked.map(p => p.toLowerCase()));
    let capSets = opts.capSets || {};
    let truncated = new Set(opts.truncated || []);
    function resolve(capability, minStake) {
        let out = (capSets[capability] || [])
            .filter(r => Number(r.weight != null ? r.weight : r.amount) >= Number(minStake))
            .map(r => ({ pubkey: r.pubkey, source: r.source, weight: String(r.weight != null ? r.weight : r.amount) }));
        out.truncated = truncated.has(capability);
        return out;
    }
    return {
        async doQuery(sql, params) { return set.has(String(params[0]).toLowerCase()) ? [{ 1: 1 }] : []; },
        async getStakeWeightsByCapability(cap, block, minStake) { return resolve(cap, minStake); },
        async getValidatorsByCapability(cap, block, minStake) { return resolve(cap, minStake); }
    };
}

// Full qualifying set the BTC resolver would report for a set of signing keys,
// matching the fixture's per-key source formula ('src_' + pubkey[:16], weight 5).
function capSetFromKeys(keys) {
    return keys.map(k => ({ pubkey: k.pubkey, source: 'src_' + k.pubkey.slice(0, 16), weight: '5' }));
}

// BTC indexer stub for the reward restore. F1a: recovery STAGES archived rewards by raw
// source-address string into recovery_pending_rewards (assigning NO index id), so the stub
// captures that INSERT. It must NOT call createAddress/getOrCreatePubkeyId at restore time;
// expose them as poisoned to assert the id-assignment path is gone (the apply hook assigns
// ids later, during the reindex, not here).
function rewardBtcDbStub() {
    let rewards = [];
    return {
        rewards,
        async createAddress() { throw new Error('recovery must not assign index ids at restore time (F1a)'); },
        async getOrCreatePubkeyId() { throw new Error('recovery must not assign pubkey ids at restore time (F1a)'); },
        async doQuery(sql, params) {
            if (sql.includes('INSERT INTO recovery_pending_rewards')) {
                rewards.push({ source_address: params[0], validator_pubkey: params[1], reward_type: params[2],
                               round_reference: params[3], amount: params[4], block_index: params[5] });
            }
            return [];
        }
    };
}

describe('AnchorRecovery (full-parse recovery) @regression @tier2', function () {
    let oracleKeys, crossKeys;
    const quiet = { log: () => {}, util };

    beforeEach(function () {
        oracleKeys = [makeKeypair(), makeKeypair(), makeKeypair(), makeKeypair()];
        crossKeys  = [makeKeypair(), makeKeypair(), makeKeypair(), makeKeypair()];
    });

    it('round-trips a chunked batch: matches + both capability sets rebuilt', async function () {
        let { v1, v2s } = buildBatch(0, [rawMatch('m1'), rawMatch('m2')], oracleKeys, crossKeys, { chunkSize: 300 });
        assert.ok(v2s.length >= 1, 'batch should actually chunk');
        let db = memDb([v1], v2s);
        let report = await new AnchorRecovery(db, quiet).run();

        assert.strictEqual(report.verified, 1);
        assert.strictEqual(report.failed.length, 0);
        assert.strictEqual(db.matches.length, 2);
        assert.ok(db.matches.every(m => m.status === 'finalized'));
        assert.strictEqual(db.snapshots.filter(s => s.capability === 'cross_chain').length, 4);
        assert.strictEqual(db.snapshots.filter(s => s.capability === 'oracle_publish').length, 4);
    });

    it('latest-status-wins: a later batch retracts an earlier finalized match', async function () {
        let b0 = buildBatch(0, [rawMatch('m1', 'finalized')], oracleKeys, crossKeys);
        let b1 = buildBatch(1, [rawMatch('m1', 'retracted')], oracleKeys, crossKeys);
        let db = memDb([b0.v1, b1.v1], []);
        let report = await new AnchorRecovery(db, quiet).run();

        assert.strictEqual(report.verified, 2);
        assert.strictEqual(db.matches.length, 1);
        assert.strictEqual(db.matches[0].status, 'retracted');
    });

    it('skips anchor rows the chain parse recorded as invalid (status filter, not replayed)', async function () {
        // A v1 the on-chain parse recorded invalid (e.g. insufficient valid signatures, or a stale
        // CHECKPOINT_SEQ / MATCH_BATCH_SEQ replay) is written to anchor_actions with its archive_b64
        // intact but a non-'valid' status. recovery.run() must not select it - otherwise a
        // recovery-fed indexer replays matches/calls a mirror-fed indexer never derived, or a
        // self-consistent forged archive authenticates itself in. Every sibling reader
        // (getMaxAnchorBatchSeq) already restricts to status IN ('valid','unverified').
        let good = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys);
        let bad  = buildBatch(1, [rawMatch('m2')], oracleKeys, crossKeys);
        bad.v1.status = 'invalid: insufficient valid signatures';
        let db = memDb([good.v1, bad.v1], []);
        let report = await new AnchorRecovery(db, quiet).run();

        // Only the valid batch is even considered (the invalid row is filtered out by the query).
        assert.strictEqual(report.batches, 1);
        assert.strictEqual(report.verified, 1);
        assert.strictEqual(db.matches.length, 1);
        assert.strictEqual(db.matches[0].match_id, 'm1');
    });

    it('rejects a corrupted CRC and an incomplete chunk set', async function () {
        let bad   = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys, { corruptCrc: true });
        let multi = buildBatch(1, [rawMatch('m2')], oracleKeys, crossKeys, { chunkSize: 200 });
        let db = memDb([bad.v1, multi.v1], multi.v2s.slice(0, multi.v2s.length - 1));   // drop the last chunk
        let report = await new AnchorRecovery(db, quiet).run();

        assert.strictEqual(report.verified, 0);
        assert.strictEqual(report.failed.length, 2);
        assert.ok(report.failed[0].reason.includes('BATCH_CRC32'));
        assert.ok(report.failed[1].reason.includes('incomplete batch'));
        assert.strictEqual(db.matches.length, 0);
    });

    it('rejects a sub-quorum wrapper and sub-quorum match signatures', async function () {
        let weakWrapper = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys, { wrapperSigners: 2 });   // 2 < 2f+1 = 3
        let weakMatch   = buildBatch(1, [rawMatch('m2')], oracleKeys, crossKeys, { matchSigners: 2 });
        let db = memDb([weakWrapper.v1, weakMatch.v1], []);
        let report = await new AnchorRecovery(db, quiet).run();

        assert.strictEqual(report.verified, 0);
        assert.ok(report.failed[0].reason.includes('wrapper signatures fail quorum'));
        assert.ok(report.failed[1].reason.includes('fails quorum against the archived cross_chain set'));
    });

    it('--verify-stakes kills a fabricated validator set with no on-chain stakes', async function () {
        let { v1 } = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys);
        let allStaked = oracleKeys.concat(crossKeys).map(k => k.pubkey);
        let okReport = await new AnchorRecovery(memDb([v1], []), Object.assign({ btcDb: btcDbStub(allStaked), verifyStakes: true }, quiet)).run();
        assert.strictEqual(okReport.verified, 1);

        let partial = allStaked.filter(p => p !== crossKeys[0].pubkey);
        let badReport = await new AnchorRecovery(memDb([v1], []), Object.assign({ btcDb: btcDbStub(partial), verifyStakes: true }, quiet)).run();
        assert.strictEqual(badReport.verified, 0);
        assert.ok(badReport.failed[0].reason.includes('no on-chain stake'));
    });

    it('stake cross-check is gated on the explicit flag, not btcDb presence (restore runs against an EMPTY pre-reindex BTC DB)', async function () {
        let { v1 } = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys);
        // btcDb present but knows NO stakes (pre-reindex) and the flag is off;
        // the batch must still verify, or the reward-restore step of the
        // recovery runbook would fail every batch before the reindex runs.
        let report = await new AnchorRecovery(memDb([v1], []), Object.assign({ btcDb: rewardBtcDbStub() }, quiet)).run();
        assert.strictEqual(report.verified, 1);
    });

    describe('completeness cross-check (REC-SUBSET-1)', function () {

        it('an honest full archived snapshot passes the source completeness check', async function () {
            let { v1 } = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys);
            let allStaked = oracleKeys.concat(crossKeys).map(k => k.pubkey);
            let capSets = { cross_chain: capSetFromKeys(crossKeys), oracle_publish: capSetFromKeys(oracleKeys) };
            let report = await new AnchorRecovery(memDb([v1], []),
                Object.assign({ btcDb: btcDbStub(allStaked, { capSets }), verifyStakes: true }, quiet)).run();
            assert.strictEqual(report.verified, 1);
            assert.strictEqual(report.failed.length, 0);
        });

        it('rejects a subset snapshot that dropped a qualifying source (the forge)', async function () {
            // The archive carries the honest 4-source cross_chain set, but on-chain a FIFTH
            // qualifying source exists that the archive omitted (an evicted honest source).
            // Existence (_verifyStakes) passes - every ARCHIVED key is staked - but the
            // completeness resolver reports the dropped source, so the batch must fail.
            let { v1 } = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys);
            let allStaked = oracleKeys.concat(crossKeys).map(k => k.pubkey);
            let ghost = makeKeypair();
            let capSets = {
                cross_chain: capSetFromKeys(crossKeys).concat([{ pubkey: ghost.pubkey, source: 'src_ghost', weight: '5' }]),
                oracle_publish: capSetFromKeys(oracleKeys)
            };
            let report = await new AnchorRecovery(memDb([v1], []),
                Object.assign({ btcDb: btcDbStub(allStaked, { capSets }), verifyStakes: true }, quiet)).run();
            assert.strictEqual(report.verified, 0);
            assert.ok(report.failed[0].reason.includes('incomplete'));
            assert.ok(report.failed[0].reason.includes('cross_chain'));
        });

        it('fails closed when the on-chain resolution is truncated', async function () {
            let { v1 } = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys);
            let allStaked = oracleKeys.concat(crossKeys).map(k => k.pubkey);
            let capSets = { cross_chain: capSetFromKeys(crossKeys), oracle_publish: capSetFromKeys(oracleKeys) };
            let report = await new AnchorRecovery(memDb([v1], []),
                Object.assign({ btcDb: btcDbStub(allStaked, { capSets, truncated: ['cross_chain'] }), verifyStakes: true }, quiet)).run();
            assert.strictEqual(report.verified, 0);
            assert.ok(report.failed[0].reason.includes('truncated'));
        });

        it('a subset dropping a lower-weight source below the archive floor is NOT flagged (no false-reject)', async function () {
            // The completeness threshold is the archive's own minimum admitted weight. A source
            // with LESS weight than that floor is below the bar the archive itself set, so its
            // absence is not a forge signal - the honest full-archive property must not misfire.
            let { v1 } = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys);
            let allStaked = oracleKeys.concat(crossKeys).map(k => k.pubkey);
            let dust = makeKeypair();
            let capSets = {
                cross_chain: capSetFromKeys(crossKeys).concat([{ pubkey: dust.pubkey, source: 'src_dust', weight: '1' }]),
                oracle_publish: capSetFromKeys(oracleKeys)
            };
            let report = await new AnchorRecovery(memDb([v1], []),
                Object.assign({ btcDb: btcDbStub(allStaked, { capSets }), verifyStakes: true }, quiet)).run();
            assert.strictEqual(report.verified, 1);
        });
    });

    describe('archived rewards', function () {

        function reward(overrides) {
            return Object.assign({
                validator_pubkey: 'a'.repeat(64), source: '1StakeAddr',
                round_number: 7, reward_type: 'anchor_BTC',
                amount: '10.00000000', block_index: SNAPSHOT_BLOCK
            }, overrides || {});
        }

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
            // F1a: staged by RAW source-address string (no id), to be materialized under the
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
            // anchor_archive is v6-derived at/above ITS flag-day (, regtest = genesis):
            // pinned to the frozen ARCHIVE constant for the same recovered==live reason.
            assert.strictEqual(byType['anchor_archive'].amount, '10.00000000');
        });

        it('keeps the archived anchor_archive amount below the ARCHIVE_REWARD flag-day (legacy push era)', async function () {
            // Below the archive flag-day the reward was genuinely operator-tunable and
            // hub-pushed, so the archived amount IS what live nodes credited; pinning
            // it would fork the other way.
            let arMod = require('../../src/anchor_reward_activation.js');
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

        it('rejects an archive claiming a derived reward type (oracle_round must never ride the archive)', async function () {
            let { v1 } = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys,
                                    { rewards: [reward({ reward_type: 'oracle_round' })] });
            let report = await new AnchorRecovery(memDb([v1], []), Object.assign({ btcDb: rewardBtcDbStub() }, quiet)).run();
            assert.strictEqual(report.verified, 0);
            assert.ok(report.failed[0].reason.includes('only anchor publish rewards are archivable'));
        });

        it('fails the batch when rewards are present but no BTC DB handle was provided', async function () {
            let { v1 } = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys, { rewards: [reward()] });
            let report = await new AnchorRecovery(memDb([v1], []), quiet).run();
            assert.strictEqual(report.verified, 0);
            assert.ok(report.failed[0].reason.includes('no BTC indexer DB handle'));
        });

        it('rejects a reward row missing its earn-time source', async function () {
            let { v1 } = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys, { rewards: [reward({ source: '' })] });
            let report = await new AnchorRecovery(memDb([v1], []), Object.assign({ btcDb: rewardBtcDbStub() }, quiet)).run();
            assert.strictEqual(report.verified, 0);
            assert.ok(report.failed[0].reason.includes('earn-time source'));
        });
    });

    describe('archived XCALL relay rows', function () {

        it('round-trips both phases: a DISPATCH and a RESULT row rebuild', async function () {
            let { v1 } = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys,
                                    { calls: [rawCall('c1', 'dispatch'), rawCall('c1', 'result')] });
            let db = memDb([v1], []);
            let report = await new AnchorRecovery(db, quiet).run();

            assert.strictEqual(report.verified, 1);
            assert.strictEqual(report.failed.length, 0);
            assert.strictEqual(report.calls, 2);
            assert.strictEqual(db.calls.length, 2);
            // Same call_id, distinct phases: the composite key keeps both rows.
            assert.deepStrictEqual(db.calls.map(c => c.phase).sort(), ['dispatch', 'result']);
            assert.ok(db.calls.every(c => c.call_id === 'c1' && c.status === 'finalized'));
        });

        it('persists finalizing_view so a view>0 round rebuilds at the correct view (#4210)', async function () {
            // A leader failover finalized this round at view 2. The EQUIV canonical
            // is view-bearing, so the persisted row MUST carry finalizing_view=2 or a
            // recovered node re-verifies the hub sigs at view 0 → strands the call /
            // forks re-derivation. The verifier passes either way (it reads the
            // archive's view); only the persisted column exposes the drop.
            let { v1 } = buildBatch(0, [Object.assign(rawMatch('m1'), { finalizing_view: 2 })],
                                    oracleKeys, crossKeys,
                                    { calls: [rawCall('c1', 'dispatch', { finalizing_view: 2 })] });
            let db = memDb([v1], []);
            let report = await new AnchorRecovery(db, quiet).run();

            assert.strictEqual(report.failed.length, 0);
            assert.strictEqual(Number(db.calls[0].finalizing_view), 2, 'call view preserved');
            assert.strictEqual(Number(db.matches[0].finalizing_view), 2, 'match view preserved');
        });

        it('latest-status-wins: a later batch retracts an earlier finalized call (per phase)', async function () {
            let b0 = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys,
                                { calls: [rawCall('c1', 'dispatch', { status: 'finalized' })] });
            let b1 = buildBatch(1, [rawMatch('m2')], oracleKeys, crossKeys,
                                { calls: [rawCall('c1', 'dispatch', { status: 'retracted' })] });
            let db = memDb([b0.v1, b1.v1], []);
            let report = await new AnchorRecovery(db, quiet).run();

            assert.strictEqual(report.verified, 2);
            assert.strictEqual(db.calls.length, 1);
            assert.strictEqual(db.calls[0].status, 'retracted');
        });

        it('re-finalized-wins: a later batch re-finalizes a retracted call with NEW content (full-column upgrade, not status-only)', async function () {
            // A source-chain reorg retracts a dispatched call; the hub re-mines and
            // re-finalizes the SAME (call_id, phase) with a LATER effective_time and a
            // fresh quorum's signatures. Both versions archive in successive batches.
            // Recovery replays latest-status-wins; the existing-row branch must overwrite
            // the FULL signed content when the incoming batch is finalized (mirroring
            // hub_db_sync's ODKU), or the rebuilt row keeps the pre-reorg effective_time /
            // signatures under status='finalized' and forks the injection block + 2f+1
            // re-verification vs mirror-fed nodes. effective_time is signed into the call
            // canonical, so the batch-1 signatures differ from batch-0's automatically.
            let b0 = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys,
                                { calls: [rawCall('c1', 'dispatch', { status: 'retracted', effective_time: 1700000000 })] });
            let b1 = buildBatch(1, [rawMatch('m2')], oracleKeys, crossKeys,
                                { calls: [rawCall('c1', 'dispatch', { status: 'finalized', effective_time: 1700009999 })] });
            let db = memDb([b0.v1, b1.v1], []);
            let report = await new AnchorRecovery(db, quiet).run();

            assert.strictEqual(report.verified, 2);
            assert.strictEqual(db.calls.length, 1);
            let row = db.calls[0];
            assert.strictEqual(row.status, 'finalized', 're-finalized status wins');
            // The re-finalized content must win, not just the status.
            assert.strictEqual(Number(row.effective_time), 1700009999, 're-finalized effective_time wins');
            // batch-1 signatures are over the new (later effective_time) canonical, so the
            // stored signatures must be batch-1's, not batch-0's stale set.
            let sigs = JSON.parse(row.validator_signatures);
            let b1Canon = require('../fixtures/anchor-archive.js').callCanonical(
                rawCall('c1', 'dispatch', { status: 'finalized', effective_time: 1700009999 }));
            let expectSig = require('../fixtures/anchor-archive.js').signHex(crossKeys[0], b1Canon);
            let has = sigs.some(s => s.pubkey === crossKeys[0].pubkey && s.sig === expectSig);
            assert.ok(has, 'validator_signatures are batch-1 (re-finalized) signatures over the new effective_time');
        });

        it('a RESULT does not collide with the DISPATCH of the same call_id (no spurious status move)', async function () {
            // Batch 0 finalizes the dispatch; batch 1 lands the result. The result
            // INSERT must not be mistaken for an UPDATE of the dispatch row.
            let b0 = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys,
                                { calls: [rawCall('c1', 'dispatch', { status: 'finalized' })] });
            let b1 = buildBatch(1, [rawMatch('m2')], oracleKeys, crossKeys,
                                { calls: [rawCall('c1', 'result', { status: 'finalized' })] });
            let db = memDb([b0.v1, b1.v1], []);
            let report = await new AnchorRecovery(db, quiet).run();

            assert.strictEqual(report.verified, 2);
            assert.strictEqual(db.calls.length, 2);
            assert.strictEqual(db.calls.filter(c => c.phase === 'dispatch').length, 1);
            assert.strictEqual(db.calls.filter(c => c.phase === 'result').length, 1);
        });

        it('rejects a call with sub-quorum signatures against the archived cross_chain set', async function () {
            let { v1 } = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys,
                                    { calls: [rawCall('c1', 'dispatch')], callSigners: 2 });   // 2 < 2f+1 = 3
            let db = memDb([v1], []);
            let report = await new AnchorRecovery(db, quiet).run();

            assert.strictEqual(report.verified, 0);
            assert.ok(report.failed[0].reason.includes('fails quorum against the archived cross_chain set'));
            assert.ok(report.failed[0].reason.includes('dispatch'));
            assert.strictEqual(db.calls.length, 0);
        });

        it('a RESULT row signed by the oracle set (not cross_chain) fails quorum', async function () {
            // The RESULT-phase canonical must verify against the archived
            // cross_chain set specifically: federation membership alone (e.g. a
            // valid oracle_publish signer) is not enough to authorize a relay row.
            let { v1 } = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys,
                                    { calls: [rawCall('c1', 'result')], callKeys: oracleKeys });
            let db = memDb([v1], []);
            let report = await new AnchorRecovery(db, quiet).run();

            assert.strictEqual(report.verified, 0);
            assert.ok(report.failed[0].reason.includes('fails quorum against the archived cross_chain set'));
            assert.ok(report.failed[0].reason.includes('result'));
            assert.strictEqual(db.calls.length, 0);
        });
    });
});
