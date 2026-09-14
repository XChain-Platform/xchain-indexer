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

// AnchorRecovery XCALL relay rows: cross_chain_calls rebuilt from the archive per
// (call_id, phase), latest status wins with a re-finalize carrying its new signed
// content, and relay rows verified against the archived cross_chain set only.
// Part of the suite whose entry is test/unit/recovery.test.js.

process.env.INDEXER_COIN = 'DOGE';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');

const AnchorRecovery = require('../../../bin/recovery.js');

// Publisher-faithful archive builder and the database stubs, shared with the
// suite entry test/unit/recovery.test.js.
const { makeKeypair, buildBatch, rawMatch, rawCall } = require('../../fixtures/anchor-archive.js');
const { util, memDb } = require('../../helpers/recovery_stubs.js');

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

    // ── XCALL relay-row restore (cross_chain_calls; the XCALL recoverability leg) ──
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
    });
});

describe('AnchorRecovery (full-parse recovery) @regression @tier2', function () {
    beforeEach(freshKeys);

    describe('archived XCALL relay rows', function () {
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
            let b1Canon = require('../../fixtures/anchor-archive.js').callCanonical(
                rawCall('c1', 'dispatch', { status: 'finalized', effective_time: 1700009999 }));
            let expectSig = require('../../fixtures/anchor-archive.js').signHex(crossKeys[0], b1Canon);
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
    });
});

describe('AnchorRecovery (full-parse recovery) @regression @tier2', function () {
    beforeEach(freshKeys);

    describe('archived XCALL relay rows', function () {
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
