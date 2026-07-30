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
const { makeKeypair, signHex, buildBatch, rawMatch, rawCall, SNAPSHOT_BLOCK } = require('../fixtures/anchor-archive.js');

// Stake-weighted quorum (WI-1) is active for every regtest snapshot_block
// (STAKE_WEIGHTED_QUORUM_ACTIVATION.regtest = 0), so recovery takes the weighted
// predicate, which needs the indexer's bcmath. Each archived snapshot below
// carries a DISTINCT source at equal weight, so the source-deduped threshold
// (3·Σweight > 2·S) reduces to the legacy 2f+1 signer count.
const util = new Utility();

// The address every fixture anchor is authored by, i.e. the archive head's SOURCE
// (#3075). A chunk is only counted when it shares the canonical head's author, so
// fixtures that omit `source` on either side are treated as this one and behave exactly
// as they did before the authorship filter existed.
const AUTHOR   = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const OUTSIDER = 'mzBc4XEFSdzCDcTxAgf6EZXgsZWpztRhef';

// In-memory DOGE indexer DB for the recovery query surface.
// opts.noTx: expose ONLY doQuery, modelling a raw query handle with no transaction API
// (recovery must still rebuild against one; see the back-compat case below). Otherwise the
// stub implements begin/commit/rollback with snapshot semantics, so the per-batch
// transaction (#3213) is exercised by every test in this file.
function memDb(v1s, v2s, opts) {
    opts = opts || {};
    let matches = [], snapshots = [], calls = [];
    let saved = null;
    const clone = (rows) => rows.map(r => Object.assign({}, r));
    const restore = (target, rows) => { target.length = 0; for (let r of rows) target.push(r); };
    let db = {
        matches, snapshots, calls,
        async doQuery(sql, params) {
            params = params || [];
            // recovery.run() now joins index_statuses and restricts to status IN
            // ('valid','unverified'), matching getArchiveReplayWatermarks. Model that here: a fixture
            // row's optional `status` property drives the filter (absent = 'valid', so the
            // pre-existing fixtures are unaffected). A row parsed as invalid is excluded, exactly
            // as the INNER JOIN + status set drops it against the real schema.
            if (sql.startsWith('SELECT a.* FROM anchor_actions a')) {
                return v1s.filter(v => {
                    let st = (v.status == null) ? 'valid' : String(v.status);
                    return st === 'valid' || st === 'unverified';
                });
            }
            // The chunk query joins index_statuses and drops rejected rows
            // (status LIKE 'invalid:%'), keeping 'valid' and 'orphan' (#2269), and since
            // #3075 also drops every chunk not authored by the batch's CANONICAL archive
            // head (earliest v1/v6 row by action_index, status-agnostic). Model both
            // filters here; recovery's own JS does the per-index dedupe. Fixture rows
            // default to AUTHOR on both sides, so pre-#3075 fixtures are unaffected.
            // Whitespace-normalized: the query is no longer a local one-liner but the
            // shared ARCHIVE_CHUNK_SET_SQL constant, which is indented across lines.
            if (String(sql).replace(/\s+/g, ' ').trim()
                    .startsWith('SELECT c.*, cadr.address AS source FROM anchor_actions c')) {
                let head = v1s
                    .filter(v => Number(v.match_batch_seq) === Number(params[0]))
                    .sort((a, b) => Number(a.action_index || 0) - Number(b.action_index || 0))[0];
                let headAuthor = head ? (head.source === undefined ? AUTHOR : head.source) : null;
                return v2s
                    .filter(c => Number(c.match_batch_seq) === Number(params[0]))
                    .filter(c => !String(c.status == null ? 'valid' : c.status).startsWith('invalid:'))
                    .filter(c => headAuthor !== null && headAuthor !== undefined &&
                                 (c.source === undefined ? AUTHOR : c.source) === headAuthor)
                    .sort((a, b) => (Number(a.chunk_index) - Number(b.chunk_index)) ||
                                    (Number(a.action_index || 0) - Number(b.action_index || 0)));
            }
            if (sql.startsWith('INSERT IGNORE INTO capability_snapshots')) {
                let [snapshot_block, capability, signing_pubkey, amount] = params;
                if (!snapshots.some(r => r.snapshot_block === snapshot_block && r.capability === capability && r.signing_pubkey === signing_pubkey))
                    snapshots.push({ snapshot_block, capability, signing_pubkey, amount });
                return [];
            }
            if (sql.startsWith('SELECT match_id FROM cross_chain_matches'))
                return matches.filter(r => r.match_id === params[0]).map(r => ({ match_id: r.match_id }));
            if (sql.startsWith('UPDATE cross_chain_matches SET status')) {
                if (sql.includes('effective_time')) {
                    // Revive content upgrade (#3208). params = [status, effective_time,
                    // finalizing_view, validator_signatures, anchorTxid, match_id].
                    for (let r of matches) if (r.match_id === params[5]) {
                        r.status               = params[0];
                        r.effective_time       = params[1];
                        r.finalizing_view      = params[2];
                        r.validator_signatures = params[3];
                        if (r.anchor_txid == null) r.anchor_txid = params[4];
                    }
                    return [];
                }
                // Status-only update (non-finalized incoming). params = [status, anchorTxid,
                // match_id]; anchor_txid upgrades NULL->value only (COALESCE semantics).
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
                               effective_time: params[21], validator_signatures: params[22],
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
    if (opts.noTx) return { matches, snapshots, calls, doQuery: db.doQuery };
    // Snapshot/restore transaction semantics: enough to prove a rolled-back batch leaves
    // NOTHING behind, which is the whole point of the per-batch transaction (#3213).
    db.txDepth = 0;
    db.commits = 0;
    db.rollbacks = 0;
    db.beginTransaction = async function () {
        assert.strictEqual(db.txDepth, 0, 'recovery must not nest transactions on one handle');
        db.txDepth = 1;
        saved = { matches: clone(matches), snapshots: clone(snapshots), calls: clone(calls) };
    };
    db.commitTransaction = async function () {
        assert.strictEqual(db.txDepth, 1, 'commit without an open transaction');
        db.txDepth = 0; db.commits++; saved = null;
    };
    db.rollbackTransaction = async function () {
        if (db.txDepth === 0) return;                     // no-op after a commit, like Database
        db.txDepth = 0; db.rollbacks++;
        restore(matches, saved.matches); restore(snapshots, saved.snapshots); restore(calls, saved.calls);
        saved = null;
    };
    return db;
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
// opts.failOnRewardIndex: throw when staging the Nth (0-based) reward row, modelling a DB
// error part-way through a batch. opts.noTx: raw handle with no transaction API.
function rewardBtcDbStub(opts) {
    opts = opts || {};
    let rewards = [];
    let saved = null;
    let db = {
        rewards,
        async createAddress() { throw new Error('recovery must not assign index ids at restore time (F1a)'); },
        async getOrCreatePubkeyId() { throw new Error('recovery must not assign pubkey ids at restore time (F1a)'); },
        async doQuery(sql, params) {
            if (sql.includes('INSERT INTO recovery_pending_rewards')) {
                if (opts.failOnRewardIndex === rewards.length) throw new Error('ER_LOCK_DEADLOCK: staging failed');
                rewards.push({ source_address: params[0], validator_pubkey: params[1], reward_type: params[2],
                               round_reference: params[3], amount: params[4], block_index: params[5] });
            }
            return [];
        }
    };
    if (opts.noTx) return db;
    db.commits = 0;
    db.rollbacks = 0;
    db.beginTransaction = async function () { saved = rewards.map(r => Object.assign({}, r)); };
    db.commitTransaction = async function () { db.commits++; saved = null; };
    db.rollbackTransaction = async function () {
        if (saved === null) return;
        db.rollbacks++;
        rewards.length = 0; for (let r of saved) rewards.push(r);
        saved = null;
    };
    return db;
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

    it('revive-wins: a later batch re-finalizes a retracted match with NEW content (#3208)', async function () {
        // A source-chain reorg retracts a crossing; the SAME crossing re-forms at the same
        // BTC snapshot_block, so _deriveMatchId yields the identical match_id and the hub
        // REVIVES the row with this round's effective_time / view / signatures
        // (CrossChainDexEngine._insertMatchRow), re-archiving it in a later batch. A
        // status-only update on the existing-row branch kept batch 0's effective_time - which
        // GATES the settlement block - and batch 0's signature set under status='finalized',
        // so a recovery-fed node settled at a different block than a mirror-fed one and
        // failed 2f+1 re-verification. effective_time is signed into the match canonical, so
        // batch 1's signatures differ from batch 0's automatically.
        let pre  = Object.assign(rawMatch('m1', 'retracted'), { effective_time: 1700000000, finalizing_view: 0 });
        let post = Object.assign(rawMatch('m1', 'finalized'), { effective_time: 1700009999, finalizing_view: 3 });
        let b0 = buildBatch(0, [pre],  oracleKeys, crossKeys);
        let b1 = buildBatch(1, [post], oracleKeys, crossKeys);
        let db = memDb([b0.v1, b1.v1], []);
        let report = await new AnchorRecovery(db, quiet).run();

        assert.strictEqual(report.verified, 2);
        assert.strictEqual(db.matches.length, 1);
        let row = db.matches[0];
        assert.strictEqual(row.status, 'finalized', 'revived status wins');
        assert.strictEqual(Number(row.effective_time), 1700009999, 'revived effective_time wins');
        assert.strictEqual(Number(row.finalizing_view), 3, 'revived finalizing_view wins');
        // The stored signatures must be batch 1's, over the NEW (later effective_time,
        // view 3) canonical - not batch 0's stale set.
        let sigs    = JSON.parse(row.validator_signatures);
        let archive = require('../fixtures/anchor-archive.js');
        let expect  = archive.signHex(crossKeys[0], archive.matchCanonical(post));
        assert.ok(sigs.some(s => s.pubkey === crossKeys[0].pubkey && s.sig === expect),
            'validator_signatures are the revived round\'s, over the new effective_time/view');
    });

    it('a retraction after a finalize moves only the status, never the signed content (#3208)', async function () {
        // The inverse guard: the hub never rewrites content on a retraction, so neither may
        // recovery. Otherwise the revive upgrade above would become a general last-batch-wins
        // overwrite and a retraction batch could regress a row's signed terms.
        let first = Object.assign(rawMatch('m1', 'finalized'), { effective_time: 1700000000, finalizing_view: 2 });
        let later = Object.assign(rawMatch('m1', 'retracted'), { effective_time: 1700009999, finalizing_view: 9 });
        let b0 = buildBatch(0, [first], oracleKeys, crossKeys);
        let b1 = buildBatch(1, [later], oracleKeys, crossKeys);
        let db = memDb([b0.v1, b1.v1], []);
        let report = await new AnchorRecovery(db, quiet).run();

        assert.strictEqual(report.verified, 2);
        assert.strictEqual(db.matches.length, 1);
        assert.strictEqual(db.matches[0].status, 'retracted');
        assert.strictEqual(Number(db.matches[0].effective_time), 1700000000, 'content untouched by a retraction');
        assert.strictEqual(Number(db.matches[0].finalizing_view), 2, 'content untouched by a retraction');
    });

    it('skips anchor rows the chain parse recorded as invalid (status filter, not replayed)', async function () {
        // A v1 the on-chain parse recorded invalid (e.g. insufficient valid signatures, or a stale
        // CHECKPOINT_SEQ / MATCH_BATCH_SEQ replay) is written to anchor_actions with its archive_b64
        // intact but a non-'valid' status. recovery.run() must not select it - otherwise a
        // recovery-fed indexer replays matches/calls a mirror-fed indexer never derived, or a
        // self-consistent forged archive authenticates itself in. Every sibling reader
        // (getArchiveReplayWatermarks) already restricts to status IN ('valid','unverified').
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

    it('a rejected junk v2 chunk neither blocks the batch nor enters the reassembly (#2269)', async function () {
        let multi = buildBatch(2, [rawMatch('m3')], oracleKeys, crossKeys, { chunkSize: 200 });
        assert.ok(multi.v2s.length >= 1, 'batch should actually chunk');
        // A permissionless junk tx for an existing (batch, index): parsed, rejected,
        // but still stored as a countable anchor_actions row. Unfiltered, this row
        // inflated the count past totalChunks-1 ('incomplete batch' forever); its
        // junk bytes must also never reach the b64 concat.
        let junk = { version: 2, match_batch_seq: 2, chunk_index: multi.v2s[0].chunk_index,
                     archive_b64: 'AAAAjunkAAAA', action_index: 999999,
                     status: 'invalid: TOTAL_CHUNKS (does not match parent v1)' };
        let db = memDb([multi.v1], multi.v2s.concat([junk]));
        let report = await new AnchorRecovery(db, quiet).run();

        assert.strictEqual(report.verified, 1, JSON.stringify(report.failed));
        assert.strictEqual(report.failed.length, 0);
        assert.strictEqual(db.matches.length, 1);
        assert.strictEqual(db.matches[0].match_id, 'm3');
    });

    // ── #3075: the case parse-time authorship cannot judge. A junk chunk broadcast
    //    BEFORE its head has no parent to authenticate against, so it is stored 'orphan'
    //    (a status that must stay usable - a legitimate early chunk carries real archive
    //    bytes). Unfiltered, that row wins the lowest-action_index dedupe for its slot,
    //    its junk bytes enter the concat, and the batch fails its signed CRC forever.
    //    The authorship term in the shared chunk query is what excludes it. ────────────
    it('a junk ORPHAN chunk from an outsider never enters the reassembly (#3075)', async function () {
        let multi = buildBatch(3, [rawMatch('m4')], oracleKeys, crossKeys, { chunkSize: 200 });
        assert.ok(multi.v2s.length >= 1, 'batch should actually chunk');
        // Lower action_index than the real chunk, so it would win the per-index dedupe.
        let junk = { version: 2, match_batch_seq: 3, chunk_index: multi.v2s[0].chunk_index,
                     archive_b64: 'AAAAjunkAAAA', action_index: 1, status: 'orphan', source: OUTSIDER };
        let real = multi.v2s.map(c => Object.assign({ action_index: 100, source: AUTHOR }, c));
        let db = memDb([Object.assign({}, multi.v1, { action_index: 50, source: AUTHOR })], [junk].concat(real));
        let report = await new AnchorRecovery(db, quiet).run();

        assert.strictEqual(report.verified, 1, JSON.stringify(report.failed));
        assert.strictEqual(db.matches.length, 1);
        assert.strictEqual(db.matches[0].match_id, 'm4');
    });

    // Teeth for the test above: the SAME orphan chunk authored by the head's own
    // publisher DOES count (that is the legitimate head-lands-last case), so the
    // assertion above turns on authorship and not on the row being an orphan.
    it('an orphan chunk from the head publisher still counts (#3075 does not reject orphans)', async function () {
        let multi = buildBatch(4, [rawMatch('m5')], oracleKeys, crossKeys, { chunkSize: 200 });
        let orphans = multi.v2s.map(c => Object.assign({ action_index: 10, source: AUTHOR, status: 'orphan' }, c));
        let db = memDb([Object.assign({}, multi.v1, { action_index: 50, source: AUTHOR })], orphans);
        let report = await new AnchorRecovery(db, quiet).run();

        assert.strictEqual(report.verified, 1, JSON.stringify(report.failed));
        assert.strictEqual(db.matches[0].match_id, 'm5');
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
            let db = memDb([v1], []);
            let report = await new AnchorRecovery(db, quiet).run();
            assert.strictEqual(report.verified, 0);
            assert.ok(report.failed[0].reason.includes('no BTC indexer DB handle'));
            // #3213: the guard is hoisted ahead of every write, so the batch leaves nothing
            // behind. It used to fire only after the match rows had already been committed.
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

    // Pkg 13 / : the recovery tally marks a pubkey into the dedupe set only
    // after its signature verifies. This is the consumer twin of the hub finalizer
    // (StateAnchorPublisher._quorumVerified, pinned by its own  test), so
    // the two must agree on the same crafted list or a rebuilt node and a live hub
    // would reach opposite verdicts on the same archived batch.
    describe('_quorumVerified verify-then-mark ordering (Pkg 13 twin parity)', function () {
        const CANON = 'XCHECKPOINTV1|recovery-parity-probe';
        const BAD   = 'ab'.repeat(64);   // well-formed hex, verifies against nothing

        // Four equal-weight sources: 3 of 4 clears both the weighted 3*tally > 2*S
        // bar and the legacy 2f+1 count, 2 of 4 clears neither.
        function setOf(keys) {
            return keys.map((k, i) => ({ pubkey: k.pubkey, source: 'src' + i, weight: '100' }));
        }
        function rec() {
            return new AnchorRecovery(memDb([], []), quiet);
        }

        it('counts a qualified signer whose valid sig is ordered AFTER a garbage one', function () {
            let keys = [makeKeypair(), makeKeypair(), makeKeypair(), makeKeypair()];
            let set  = setOf(keys);
            let sigs = [
                { pubkey: keys[0].pubkey, sig: BAD },                       // garbage first
                { pubkey: keys[0].pubkey, sig: signHex(keys[0], CANON) },   // the real one, second
                { pubkey: keys[1].pubkey, sig: signHex(keys[1], CANON) },
                { pubkey: keys[2].pubkey, sig: signHex(keys[2], CANON) }
            ];
            assert.strictEqual(rec()._quorumVerified(CANON, sigs, set, true), true,
                'weighted: the leading garbage entry must not drop a real signer');
            assert.strictEqual(rec()._quorumVerified(CANON, sigs, set, false), true,
                'count: same verdict on the legacy 2f+1 path');
        });

        it('still counts a repeated valid signer ONCE (dedupe intact)', function () {
            let keys = [makeKeypair(), makeKeypair(), makeKeypair(), makeKeypair()];
            let set  = setOf(keys);
            let sigs = [
                { pubkey: keys[0].pubkey, sig: signHex(keys[0], CANON) },
                { pubkey: keys[0].pubkey, sig: signHex(keys[0], CANON) },   // repeat of the same signer
                { pubkey: keys[1].pubkey, sig: signHex(keys[1], CANON) }
            ];
            assert.strictEqual(rec()._quorumVerified(CANON, sigs, set, true), false,
                'a repeated signer must not inflate the stake tally to quorum');
            assert.strictEqual(rec()._quorumVerified(CANON, sigs, set, false), false);
        });

        it('a signer with only garbage entries never counts, whatever the ordering', function () {
            let keys = [makeKeypair(), makeKeypair(), makeKeypair(), makeKeypair()];
            let set  = setOf(keys);
            let sigs = [
                { pubkey: keys[0].pubkey, sig: BAD },
                { pubkey: keys[0].pubkey, sig: 'cd'.repeat(64) },
                { pubkey: keys[1].pubkey, sig: signHex(keys[1], CANON) },
                { pubkey: keys[2].pubkey, sig: signHex(keys[2], CANON) }
            ];
            assert.strictEqual(rec()._quorumVerified(CANON, sigs, set, true), false,
                'verify gate is not weakened: two of four sources is sub-quorum');
        });
    });
});
