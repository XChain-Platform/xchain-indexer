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
const { createMockIndexer } = require('../../fixtures/mocks');

const Rollback = require('../../../src/rollback.js');

// Part of the Rollback suite whose entry is test/unit/rollback.test.js: the
// attestation request_status reset and the ownership-escrow re-derive, both reorg
// corrections to rows that survive the orphaned range. The suite title is the
// entry's, so every full test title is unchanged.

let indexer, rollback;

// ─── Attestation request_status reset (reorg correctness) ─────────
//
// Regression for: a reorg that orphans an ATTEST v1 (response) block must
// reset the originating request back to 'pending'. The response row lives in
// the orphaned range and is bulk-deleted, but the request row was created in
// an EARLIER block (action_index < firstActionIndex) and survives. Without a
// companion UPDATE the surviving request stays 'fulfilled'/'errored', the
// re-applied response is rejected as already-resolved, the contract callback
// never fires, and the deadline-expiry sweep (which only scans 'pending'
// requests) never re-arms.

function attestationResetUpdate() {
    const queries = indexer.indexerDb.doQuery.args.map(a => a[0]);
    return queries.find(q =>
        q &&
        /UPDATE\s+attests/i.test(q) &&
        /request_status\s*=\s*'pending'/i.test(q)
    );
}

// ─── Ownership-escrow RE-DERIVE (reorg correctness) ───
//
// tokens.escrow_action_index (the ownership gate) is an in-place projection:
// a GIVE_OWNERSHIP offer stamps it with the offer's action_index; a release
// (match/expire/cancel/close) NULLs it. After the dataTables delete, rollback
// RE-DERIVES it for every affected token = the surviving still-open
// GIVE_OWNERSHIP offer's action_index, else NULL. One pass collapses both
// directions: orphaned offer -> NULL; orphaned release on a surviving offer ->
// re-stamp. The old SET-only `escrow_action_index >= ?` reset is removed (it
// could not handle the CLEAR direction).

const AFFECTED_SQL_RE = /escrow_action_index IS NOT NULL/i;       // affected-ticker query
const REDERIVE_UPDATE_RE = /UPDATE tokens SET escrow_action_index=\?\s+WHERE tick_id=\(SELECT id FROM index_tickers/i;

function rederiveUpdateCall() {
    return indexer.indexerDb.doQuery.args.find(a => a[0] && REDERIVE_UPDATE_RE.test(a[0]));
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

    it('resets terminal attestation requests whose flip happened in the orphaned range', async function () {
        indexer.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 50 }]);
        indexer.indexerDb.doQuery.resolves([]);
        await rollback.rollback(100);

        const updateQuery = attestationResetUpdate();
        assert.ok(updateQuery, 'expected a companion UPDATE resetting the v0 request row request_status to pending');
        // Keyed on resolved_block (recorded at flip time), so BOTH terminal paths
        // reset: a v1 response (fulfilled/errored) AND a v2 expiry (expired); the
        // old v1-only self-join left a reorged expiry stuck terminal, and replay
        // then skipped re-synthesizing the v2 row (reorged-node vs fresh-sync
        // divergence).
        assert.ok(/resolved_block\s*>=\s*\?/i.test(updateQuery),
            'reset UPDATE should be keyed on resolved_block');
        assert.ok(/resolved_block\s*=\s*NULL/i.test(updateQuery),
            'reset UPDATE should clear resolved_block');
        assert.ok(/'fulfilled'.*'errored'.*'expired'/is.test(updateQuery),
            'reset UPDATE should cover every terminal status, including expiry');
        // The bound argument is the rollback target block (the flip block range).
        const call = indexer.indexerDb.doQuery.args.find(a => a[0] === updateQuery);
        assert.deepStrictEqual(call[1], [100], 'reset UPDATE should be parameterised with block_index');
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

    it('does NOT issue the request_status reset when there is no orphaned range', async function () {
        indexer.indexerDb.doQuery.resolves([]); // no firstActionIndex
        await rollback.rollback(100);
        assert.ok(!attestationResetUpdate(), 'no reset UPDATE expected when the rolled-back range is empty');
    });
    const OPEN_OFFER_RE   = /SELECT\s+o\.action_index\s+FROM\s+orders/i; // per-ticker open-offer query

    it('re-stamps escrow to a surviving open GIVE_OWNERSHIP offer (orphaned release / CLEAR direction)', async function () {
        indexer.indexerDb.doQuery.resolves([]);
        indexer.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 50 }]);  // firstActionIndex
        indexer.indexerDb.doQuery.withArgs(sinon.match(AFFECTED_SQL_RE)).resolves([{ tick: 'FOO' }]);
        indexer.indexerDb.doQuery.withArgs(sinon.match(OPEN_OFFER_RE)).resolves([{ action_index: 30 }]);
        await rollback.rollback(100);

        const call = rederiveUpdateCall();
        assert.ok(call, 'expected a re-derive UPDATE on tokens.escrow_action_index');
        // surviving offer (action_index 30 < firstActionIndex 50) holds the escrow again
        assert.deepStrictEqual(call[1], [30, 'FOO'], 're-derive should re-stamp the surviving offer action_index for the tick');
        // The old SET-only reset must be gone.
        assert.ok(!indexer.indexerDb.doQuery.args.some(a => a[0] && /escrow_action_index\s*>=\s*\?/i.test(a[0])),
            'the old SET-only `escrow_action_index >= ?` reset must no longer be issued');
    });

    it('clears escrow when no offer survives (orphaned offer / SET direction)', async function () {
        indexer.indexerDb.doQuery.resolves([]);
        indexer.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 50 }]);
        indexer.indexerDb.doQuery.withArgs(sinon.match(AFFECTED_SQL_RE)).resolves([{ tick: 'BAR' }]);
        indexer.indexerDb.doQuery.withArgs(sinon.match(OPEN_OFFER_RE)).resolves([]); // no surviving open offer
        await rollback.rollback(100);

        const call = rederiveUpdateCall();
        assert.ok(call, 'expected a re-derive UPDATE');
        assert.deepStrictEqual(call[1], [null, 'BAR'], 're-derive should NULL the gate when no offer survives');
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

    it('re-derives AFTER the dataTables delete (orphaned offers/status rows already gone)', async function () {
        indexer.indexerDb.doQuery.resolves([]);
        indexer.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 50 }]);
        indexer.indexerDb.doQuery.withArgs(sinon.match(AFFECTED_SQL_RE)).resolves([{ tick: 'FOO' }]);
        await rollback.rollback(100);

        const queries = indexer.indexerDb.doQuery.args.map(a => a[0] || '');
        const ordersDeleteIdx = queries.findIndex(q => /DELETE FROM orders WHERE action_index >= \?/i.test(q));
        const affectedIdx     = queries.findIndex(q => AFFECTED_SQL_RE.test(q));
        assert.ok(ordersDeleteIdx >= 0, 'orders dataTables delete should run');
        assert.ok(affectedIdx > ordersDeleteIdx, 'escrow re-derive must run AFTER the dataTables delete');
    });

    it('does NOT touch escrow when there is no orphaned range', async function () {
        indexer.indexerDb.doQuery.resolves([]); // no firstActionIndex
        await rollback.rollback(100);
        assert.ok(!rederiveUpdateCall(), 'no escrow re-derive UPDATE expected when the rolled-back range is empty');
        assert.ok(!indexer.indexerDb.doQuery.args.some(a => a[0] && AFFECTED_SQL_RE.test(a[0])),
            'no affected-ticker query expected when the rolled-back range is empty');
    });

    // ─── Cooldown-maturity reversal runs on an ACTION-EMPTY range (fork fix) ─────
    // A legacy (pre UNSTAKE_COOLDOWN_COMPLETION_ACTION) cooldown maturity writes its refund credit
    // + 'completed' flip against a SURVIVING unstake row and mints NO actions row in the maturity
    // block. If the orphaned range holds no other actions, firstActionIndex is null; the reversal
    // must STILL run (it is now hoisted out of the firstActionIndex guard) or the reorged node keeps
    // a phantom refund and diverges from a from-genesis replay.

    it('reverses cooldown maturities even when the orphaned range has NO actions (firstActionIndex null)', async function () {
        // No actions row at/after the reorg block: the firstActionIndex range read returns [].
        indexer.indexerDb.doQuery.resolves([]);
        await rollback.rollback(100);
        const calls = indexer.indexerDb.doQuery.getCalls();
        const capCreditDel = calls.find(c => /DELETE c FROM credits c/.test(c.args[0]) && /JOIN unstakes u/.test(c.args[0]) && c.args[0].includes('cooldown_end_block'));
        const conCreditDel = calls.find(c => /DELETE c FROM credits c/.test(c.args[0]) && /JOIN contract_unstakes cu/.test(c.args[0]));
        const capStatusReset = calls.find(c => /UPDATE unstakes SET status_id/.test(c.args[0]) && c.args[0].includes('cooldown_end_block'));
        const conStatusReset = calls.find(c => /UPDATE contract_unstakes SET status_id/.test(c.args[0]) && c.args[0].includes('cooldown_end_block') && !c.args[0].includes('contract_slash_debits'));
        assert.ok(capCreditDel, 'capability maturity-credit delete must still run with a null firstActionIndex');
        assert.ok(conCreditDel, 'contract maturity-credit delete must still run with a null firstActionIndex');
        assert.ok(capStatusReset, 'unstakes status reset must still run with a null firstActionIndex');
        assert.ok(conStatusReset, 'contract_unstakes status reset must still run with a null firstActionIndex');
    });
});
