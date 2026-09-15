// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createMockIndexer } = require('../../../fixtures/mocks');

const Rollback = require('../../../../src/rollback/index.js');

// Part of the Rollback suite whose entry is test/unit/rollback.test.js: what aborts
// and what commits the reorg transaction, namely the errno-gated recovery-reward
// re-arm, a failed push-generation bump, the in-transaction fence bump and the
// write-ahead retraction staging. The suite title is the entry's, so every full
// test title is unchanged.

let indexer, rollback;

// ─── Recovery-reward re-arm: errno-gated catch ─────────────────────
// The re-arm block runs INSIDE the atomic reorg transaction. Only the
// schema-gap errors (1146 missing table / 1054 missing column: non-recovery
// stack, nothing staged) may be swallowed; a transient DB fault must abort
// the reorg so a partial re-arm can never commit.

function rearmFailsWith(err) {
    indexer.indexerDb.doQuery.callsFake(async (query) => {
        if (query && query.includes('UPDATE recovery_pending_rewards')) throw err;
        return [];
    });
}

describe('Rollback @regression @tier3', function () {
    beforeEach(function () {
        indexer = createMockIndexer();
        // Rollback itself deliberately holds NO protocolChanges handle (see the constructor:
        // there is no unambiguous local height to gate on mid-unwind). The stub stands in for
        // the shared indexer surface the modules a rollback drives read off it.
        indexer.protocolChanges = {
            isDefined: sinon.stub().returns(true),
            isEnabled: sinon.stub().resolves(true),
        };
        rollback = new Rollback(indexer);
        indexer.util.resetLists();
    });

    // ─── Error path: rollbackTransaction called on failure ────────────

    it('calls rollbackTransaction when an error occurs inside the transaction', async function () {
        // First doQuery call returns rows (triggering the delete phase)
        indexer.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 50 }]);
        // Subsequent doQuery calls resolve normally until the commit path hits updateBalances
        indexer.indexerDb.doQuery.resolves([]);
        // Force commitTransaction to throw
        indexer.indexerDb.commitTransaction.rejects(new Error('commit failed'));
        await assert.rejects(() => rollback.rollback(100), /commit failed/);
        assert.ok(indexer.indexerDb.rollbackTransaction.calledOnce);
    });

    it('re-arm: a transient DB fault (errno 1205) aborts and rolls back the reorg transaction', async function () {
        const lockTimeout = new Error('Lock wait timeout exceeded');
        lockTimeout.errno = 1205;
        rearmFailsWith(lockTimeout);
        await assert.rejects(() => rollback.rollback(100), /Lock wait timeout/);
        assert.ok(indexer.indexerDb.rollbackTransaction.calledOnce, 'transaction must be rolled back');
        assert.ok(indexer.indexerDb.commitTransaction.notCalled, 'a partial re-arm must never commit');
    });

    it('re-arm: an errno-less error also aborts (only the schema gap is tolerated)', async function () {
        rearmFailsWith(new Error('connection killed'));
        await assert.rejects(() => rollback.rollback(100), /connection killed/);
        assert.ok(indexer.indexerDb.rollbackTransaction.calledOnce);
        assert.ok(indexer.indexerDb.commitTransaction.notCalled);
    });

    it('re-arm: missing recovery_pending_rewards table (errno 1146) is tolerated and the reorg commits', async function () {
        const noTable = new Error("Table 'x.recovery_pending_rewards' doesn't exist");
        noTable.errno = 1146;
        rearmFailsWith(noTable);
        await rollback.rollback(100);
        assert.ok(indexer.indexerDb.commitTransaction.calledOnce, 'schema-gap swallow must still commit');
        assert.ok(indexer.indexerDb.rollbackTransaction.notCalled);
    });
});

describe('Rollback @regression @tier3', function () {
    beforeEach(function () {
        indexer = createMockIndexer();
        // Rollback itself deliberately holds NO protocolChanges handle (see the constructor:
        // there is no unambiguous local height to gate on mid-unwind). The stub stands in for
        // the shared indexer surface the modules a rollback drives read off it.
        indexer.protocolChanges = {
            isDefined: sinon.stub().returns(true),
            isEnabled: sinon.stub().resolves(true),
        };
        rollback = new Rollback(indexer);
        indexer.util.resetLists();
    });

    it('re-arm: missing column (errno 1054) is tolerated and the reorg commits', async function () {
        const noColumn = new Error("Unknown column 'applied' in 'field list'");
        noColumn.errno = 1054;
        rearmFailsWith(noColumn);
        await rollback.rollback(100);
        assert.ok(indexer.indexerDb.commitTransaction.calledOnce);
        assert.ok(indexer.indexerDb.rollbackTransaction.notCalled);
    });

    // ─── DELETE queries issued ────────────────────────────────────────

    it('issues DELETE queries for blockTables using block_index', async function () {
        indexer.indexerDb.doQuery.resolves([]);
        await rollback.rollback(100);
        const queries = indexer.indexerDb.doQuery.args.map(a => a[0]);
        const blockDeletes = queries.filter(q => q && q.includes('DELETE FROM') && q.includes('block_index'));
        assert.ok(blockDeletes.length >= rollback.blockTables.length,
            `Expected at least ${rollback.blockTables.length} block_index DELETE queries, got ${blockDeletes.length}`);
    });

    it('issues a block_index DELETE for every table in blockTables (set coverage, not just a count)', async function () {
        // A raw count check (see the test above) passes even if one table is deleted
        // N times while another is skipped entirely; this asserts the actual SET of
        // deleted tables covers every declared blockTables entry.
        indexer.indexerDb.doQuery.resolves([]);
        await rollback.rollback(100);
        const queries = indexer.indexerDb.doQuery.args.map(a => a[0]).filter(q => q && typeof q === 'string');
        const deletedTables = new Set();
        for (const q of queries) {
            const m = q.match(/DELETE FROM\s+`?(\w+)`?\s+WHERE\s+(?:\w+\.)?block_index/i);
            if (m) deletedTables.add(m[1]);
        }
        const missing = rollback.blockTables.filter(t => !deletedTables.has(t));
        assert.deepStrictEqual(missing, [],
            `Every blockTables entry must appear in a block_index DELETE; missing: ${missing.join(', ')}`);
    });
});

describe('Rollback @regression @tier3', function () {
    beforeEach(function () {
        indexer = createMockIndexer();
        // Rollback itself deliberately holds NO protocolChanges handle (see the constructor:
        // there is no unambiguous local height to gate on mid-unwind). The stub stands in for
        // the shared indexer surface the modules a rollback drives read off it.
        indexer.protocolChanges = {
            isDefined: sinon.stub().returns(true),
            isEnabled: sinon.stub().resolves(true),
        };
        rollback = new Rollback(indexer);
        indexer.util.resetLists();
    });

    // ─── A failed push-generation bump rolls the transaction back ─────
    // With the bump failed there is no fence value that can separate a re-published row (at a
    // recycled action_index) from an orphan, so degrading to an un-fenced retraction would wipe
    // canonical rows. The bump runs INSIDE the rollback transaction (before commit), so a failure
    // throws into the transaction catch: every delete is rolled back, commit never happens, and no
    // retraction is delivered. The driver retries the reorg idempotently.
    it('rolls back the transaction and issues no retraction when bumpPushGeneration fails', async function () {
        const hubClient = { enabled: true, retractPriceRange: sinon.stub().resolves(), retractXcallRange: sinon.stub().resolves(), retractMatchRange: sinon.stub().resolves() };
        const idx = createMockIndexer({ hubClient });
        idx.protocolChanges = { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) };
        const rb = new Rollback(idx);
        idx.util.resetLists();
        idx.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 50 }]);
        idx.indexerDb.doQuery.resolves([]);
        idx.indexerDb.bumpPushGeneration = sinon.stub().rejects(new Error('push_generations missing'));
        let threw = false;
        try { await rb.rollback(100); } catch(e){ threw = true; }
        assert.ok(threw, 'a failed bump must abort the rollback');
        assert.ok(idx.indexerDb.rollbackTransaction.calledOnce, 'the transaction must be rolled back on bump failure');
        assert.ok(idx.indexerDb.commitTransaction.notCalled, 'the transaction must NOT commit after a failed bump');
        assert.ok(hubClient.retractPriceRange.notCalled, 'no retraction may be delivered after a failed bump');
        assert.ok(idx.indexerDb.markHubPushDelivered.notCalled, 'no write-ahead row may be marked delivered after a failed bump');
    });

    // ─── The fence bump is issued inside the transaction, before commit ─────
    it('bumps the push generation inside the transaction (after beginTransaction, before commit)', async function () {
        const idx = createMockIndexer();
        idx.protocolChanges = { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) };
        const rb = new Rollback(idx);
        idx.util.resetLists();
        idx.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 50 }]);
        idx.indexerDb.doQuery.resolves([]);
        await rb.rollback(100);
        const bumpOrder   = idx.indexerDb.bumpPushGeneration.getCall(0);
        const beginOrder  = idx.indexerDb.beginTransaction.getCall(0);
        const commitOrder = idx.indexerDb.commitTransaction.getCall(0);
        assert.ok(bumpOrder && beginOrder && commitOrder, 'begin, bump, and commit all ran');
        assert.ok(beginOrder.calledBefore(bumpOrder), 'bump must run AFTER beginTransaction (inside the tx)');
        assert.ok(bumpOrder.calledBefore(commitOrder), 'bump must run BEFORE commitTransaction');
    });
});

describe('Rollback @regression @tier3', function () {
    beforeEach(function () {
        indexer = createMockIndexer();
        // Rollback itself deliberately holds NO protocolChanges handle (see the constructor:
        // there is no unambiguous local height to gate on mid-unwind). The stub stands in for
        // the shared indexer surface the modules a rollback drives read off it.
        indexer.protocolChanges = {
            isDefined: sinon.stub().returns(true),
            isEnabled: sinon.stub().resolves(true),
        };
        rollback = new Rollback(indexer);
        indexer.util.resetLists();
    });

    // ─── Retractions are write-ahead-staged in-tx, then delivered + dropped on success ─────
    it('write-aheads all three retractions inside the tx and marks each delivered on live success', async function () {
        const hubClient = { enabled: true, retractPriceRange: sinon.stub().resolves(), retractXcallRange: sinon.stub().resolves(), retractMatchRange: sinon.stub().resolves() };
        const idx = createMockIndexer({ hubClient });
        idx.protocolChanges = { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) };
        let n = 0; idx.indexerDb.enqueueHubPushTx = sinon.stub().callsFake(async () => ++n);
        idx.indexerDb.markHubPushDelivered = sinon.stub().resolves();
        const rb = new Rollback(idx);
        idx.util.resetLists();
        idx.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 50 }]);
        idx.indexerDb.doQuery.resolves([]);
        await rb.rollback(100);
        // All three retraction types were write-ahead-staged...
        const stagedTypes = idx.indexerDb.enqueueHubPushTx.getCalls().map(c => c.args[0]);
        for (const t of ['price_retraction', 'xcall_retraction', 'match_retraction'])
            assert.ok(stagedTypes.includes(t), `expected a write-ahead ${t} row`);
        // ...before the commit (durable regardless of any post-commit crash)...
        assert.ok(idx.indexerDb.enqueueHubPushTx.getCall(0).calledBefore(idx.indexerDb.commitTransaction.getCall(0)),
            'write-ahead rows must be staged inside the transaction (before commit)');
        // ...and each was delivered live then dropped (ids 1,2,3).
        const delivered = idx.indexerDb.markHubPushDelivered.getCalls().map(c => c.args[0]).sort();
        assert.deepStrictEqual(delivered, [1, 2, 3], 'every successfully delivered write-ahead row must be dropped');
    });

    // ─── Anchor invalid_archive reset interns 'unverified' before the UPDATE ─────
    it('interns unverified via createStatus before the anchor invalid_archive reset UPDATE', async function () {
        indexer.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 50 }]); // firstActionIndex
        indexer.indexerDb.doQuery.resolves([]);
        indexer.indexerDb.createStatus = sinon.stub().resolves(1);
        await rollback.rollback(100);
        assert.ok(indexer.indexerDb.createStatus.calledWith('unverified'),
            "the reset must intern 'unverified' so the JOIN is non-empty on a node that never wrote it forward");
        const anchorUpdate = indexer.indexerDb.doQuery.getCalls().find(c =>
            /UPDATE anchor_actions p/.test(c.args[0]) && /status = 'invalid_archive'/.test(c.args[0]));
        assert.ok(anchorUpdate, 'expected the anchor invalid_archive reset UPDATE');
        // Drift-guard-preserving: the JOIN text is retained (interning happens BEFORE, not instead).
        assert.ok(/JOIN index_statuses us ON us\.status = 'unverified'/.test(anchorUpdate.args[0]),
            'the reset must keep its JOIN text so the cross-repo drift guard still matches');
        const internCall = indexer.indexerDb.createStatus.getCalls().find(c => c.args[0] === 'unverified');
        assert.ok(internCall.calledBefore(anchorUpdate), "createStatus('unverified') must run before the UPDATE");
    });
});
