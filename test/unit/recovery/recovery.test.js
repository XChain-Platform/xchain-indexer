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

const AnchorRecovery = require('../../../bin/recovery.js');

// Publisher-faithful archive builder shared with the recovery-determinism e2e
// (test/integration/recovery_determinism_e2e.test.js). Single source for the
// hub serialization both tests verify against.
const { makeKeypair, signHex, buildBatch, rawMatch, rawCall, SNAPSHOT_BLOCK } = require('../../fixtures/anchor-archive.js');

// The DOGE and BTC database stubs every AnchorRecovery part drives recovery against.
const { util, AUTHOR, OUTSIDER, ARMED_DOGE_BLOCK, memDb } = require('../../helpers/recovery_stubs.js');

// The rest of the suite lives beside this file under test/unit/recovery.test/, one
// behaviour per part: stake cross-checks, completeness, archived rewards, XCALL
// relay rows and quorum parity. Every part repeats the suite title below, so each
// full test title is unchanged.

// Fresh federation keys for every test. Held at module scope so the fixture
// builders in this file read the current test's keys, exactly as they did when
// the whole suite was one describe block.
let oracleKeys, crossKeys;
function freshKeys() {
    oracleKeys = [makeKeypair(), makeKeypair(), makeKeypair(), makeKeypair()];
    crossKeys  = [makeKeypair(), makeKeypair(), makeKeypair(), makeKeypair()];
}
const quiet = { log: () => {}, util };

describe('AnchorRecovery (full-parse recovery) @regression @tier2', function () {
    beforeEach(freshKeys);

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

    // An operator reads this line during an incident, so it must name the versions the
    // query actually scanned rather than a hardcoded set that drifts when they change.
    it('the empty-archive log names exactly ARCHIVE_HEAD_VERSIONS, never a retired wire', async function () {
        const { ARCHIVE_HEAD_VERSIONS } = require('../../../src/consensus/state_hash.js');
        let lines = [];
        let report = await new AnchorRecovery(memDb([], []), { log: m => lines.push(String(m)), util }).run();

        assert.strictEqual(report.verified, 0);
        let line = lines.find(l => l.includes('no archive anchors found'));
        assert.ok(line, 'recovery logged the empty-archive line, got: ' + JSON.stringify(lines));
        for (let v of ARCHIVE_HEAD_VERSIONS) {
            assert.ok(line.includes('v' + v), 'names the live archive version v' + v + ': ' + line);
        }
        // The retired wires specifically: v6 was the tailed archive head before the restart.
        for (let retired of [3, 4, 5, 6, 7]) {
            assert.ok(!line.includes('v' + retired),
                'must not send an operator hunting a retired v' + retired + ' row: ' + line);
        }
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
});

describe('AnchorRecovery (full-parse recovery) @regression @tier2', function () {
    beforeEach(freshKeys);

    it('revive-wins: a later batch re-finalizes a retracted match with NEW content (#3208)', async function () {
        // A source-chain reorg retracts a crossing; the SAME crossing re-forms at the same
        // BTC snapshot_block, so deriveMatchId yields the identical match_id and the hub
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
        let archive = require('../../fixtures/anchor-archive.js');
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
});

describe('AnchorRecovery (full-parse recovery) @regression @tier2', function () {
    beforeEach(freshKeys);

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
});

describe('AnchorRecovery (full-parse recovery) @regression @tier2', function () {
    beforeEach(freshKeys);

    // ── The case parse-time authorship cannot judge. A junk chunk broadcast
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
});

describe('AnchorRecovery (full-parse recovery) @regression @tier2', function () {
    beforeEach(freshKeys);

    // a junk head at the same batch seq used to CAPTURE the batch. It is the
    // earliest v1/v6 row, the head pick is status-agnostic (it must be, or mirrored and
    // unmirrored nodes fork), so its author became the only author whose chunks counted
    // and the real batch reassembled from nothing: 'incomplete batch', forever. Under
    // publisher-scoped batches each head reassembles its own publisher's chunks.
    it('a junk head squatting the batch seq no longer denies the real archive', async function () {
        let multi = buildBatch(5, [rawMatch('m6')], oracleKeys, crossKeys, { chunkSize: 200 });
        assert.ok(multi.v2s.length >= 1, 'batch should actually chunk');
        // The capture: broadcast first (lowest action_index), signatures that do not
        // verify (stored 'invalid: ...', so the replay driver skips it while the head
        // pick still sees it), and a bogus geometry for good measure.
        let junkHead = Object.assign({}, multi.v1, {
            action_index: 1, source: OUTSIDER, status: 'invalid: insufficient valid signatures',
            total_chunks: 99, archive_b64: 'JUNK', block_index_doge: ARMED_DOGE_BLOCK });
        let realHead = Object.assign({}, multi.v1, { action_index: 50, source: AUTHOR, block_index_doge: ARMED_DOGE_BLOCK });
        let chunks   = multi.v2s.map(c => Object.assign({ action_index: 100, source: AUTHOR }, c));
        let db = memDb([junkHead, realHead], chunks);
        let report = await new AnchorRecovery(db, quiet).run();

        assert.strictEqual(report.verified, 1, JSON.stringify(report.failed));
        assert.strictEqual(db.matches.length, 1);
        assert.strictEqual(db.matches[0].match_id, 'm6');
    });

    // Teeth: the junk head's own (unpublished) batch still fails on its own merits, so
    // the case above is not "authorship stopped being checked". Same seq, same rows,
    // but the head under test is the outsider's and it has no chunks of its own.
    it('a junk head reassembles only its own chunks, so it still fails', async function () {
        let multi = buildBatch(6, [rawMatch('m7')], oracleKeys, crossKeys, { chunkSize: 200 });
        // status 'valid', so the driver replays it too.
        let junkHead = Object.assign({}, multi.v1, { action_index: 1, source: OUTSIDER, block_index_doge: ARMED_DOGE_BLOCK });
        let realHead = Object.assign({}, multi.v1, { action_index: 50, source: AUTHOR, block_index_doge: ARMED_DOGE_BLOCK });
        let chunks   = multi.v2s.map(c => Object.assign({ action_index: 100, source: AUTHOR }, c));
        let db = memDb([junkHead, realHead], chunks);
        let report = await new AnchorRecovery(db, quiet).run();

        assert.strictEqual(report.verified, 1, 'the real publisher batch still verifies');
        assert.strictEqual(report.failed.length, 1, 'the outsider head has no chunks of its own');
        assert.match(report.failed[0].reason, /incomplete batch/);
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
});
