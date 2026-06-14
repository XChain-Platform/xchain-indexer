// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createMockIndexer } = require('../fixtures/mocks');

const Rollback = require('../../src/rollback.js');

describe('Rollback @regression @tier3', function () {
    let indexer, rollback;

    beforeEach(function () {
        indexer = createMockIndexer();
        // Rollback accesses indexer.protocolChanges; set a stub
        indexer.protocolChanges = {
            isDefined: sinon.stub().returns(true),
            isEnabled: sinon.stub().resolves(true),
        };
        rollback = new Rollback(indexer);
        indexer.util.resetLists();
    });

    // ─── Table array contents ─────────────────────────────────────────

    it('blockTables contains blocks and transactions', function () {
        assert.ok(rollback.blockTables.includes('blocks'));
        assert.ok(rollback.blockTables.includes('transactions'));
    });

    it('dataTables contains expected core tables', function () {
        const expected = ['actions', 'credits', 'debits', 'escrows', 'issues', 'swaps', 'orders', 'mappings_actions'];
        for (const table of expected) {
            assert.ok(rollback.dataTables.includes(table), `dataTables should include '${table}'`);
        }
    });

    it('dataTables contains all dispenser-related tables', function () {
        const dispenserTables = ['dispensers', 'dispenser_cancels', 'dispenser_closes', 'dispenser_edits', 'dispenser_expires', 'dispenser_statuses', 'dispenses'];
        for (const table of dispenserTables) {
            assert.ok(rollback.dataTables.includes(table), `dataTables should include '${table}'`);
        }
    });

    it('dataTables contains the prices table so orphaned PRICE rows are pruned', function () {
        assert.ok(rollback.dataTables.includes('prices'), `dataTables should include 'prices'`);
    });

    it('dataTables contains all contract-staking tables so orphaned STAKE/UNSTAKE/DELEGATE rows are pruned', function () {
        const stakingTables = ['contract_stakes', 'contract_unstakes', 'contract_delegations'];
        for (const table of stakingTables) {
            assert.ok(rollback.dataTables.includes(table), `dataTables should include '${table}'`);
        }
    });

    // ─── Contract-staking pre-scan (addresses/tickers collection) ─────

    it('pre-scans contract-staking tables and feeds affected addresses/tickers to updateBalances/updateTokens', async function () {
        // First query (firstActionIndex lookup) returns an orphaned range;
        // each contract-staking pre-scan SELECT returns one affected (address, tick) row.
        indexer.indexerDb.doQuery.callsFake(async (query) => {
            if (/FROM\s+actions\s+a/i.test(query) && /a\.action_index/i.test(query)) return [{ action_index: 50 }];
            if (query.includes('contract_stakes') && query.includes('source_id')) return [{ tick: 'CSTK', address: 'addrStake' }];
            if (query.includes('contract_unstakes') && query.includes('source_id')) return [{ tick: 'CUNS', address: 'addrUnstake' }];
            if (query.includes('contract_delegations') && query.includes('source_id')) return [{ tick: 'CDEL', address: 'addrDeleg' }];
            return [];
        });

        await rollback.rollback(100);

        // A pre-scan SELECT (joined on source_id) was issued for each of the three tables
        const queries = indexer.indexerDb.doQuery.args.map(a => a[0]);
        for (const table of ['contract_stakes', 'contract_unstakes', 'contract_delegations']) {
            assert.ok(
                queries.some(q => q && /SELECT/i.test(q) && q.includes(table) && q.includes('source_id')),
                `expected a pre-scan SELECT joining '${table}' on source_id`
            );
        }

        // The collected addresses/tickers reach the post-rollback recompute
        const balanceArg = indexer.indexerDb.updateBalances.firstCall.args[0];
        assert.ok(balanceArg.includes('addrStake') && balanceArg.includes('addrUnstake') && balanceArg.includes('addrDeleg'),
            'updateBalances should receive the staking addresses from all three tables');
        const tokenArg = indexer.indexerDb.updateTokens.firstCall.args[0];
        assert.ok(tokenArg.includes('CSTK') && tokenArg.includes('CUNS') && tokenArg.includes('CDEL'),
            'updateTokens should receive the tickers from all three tables');
    });

    // ─── Hub price retraction signal ──────────────────────────────────

    it('signals the hub to retract prices for the rolled-back range', async function () {
        const hubClient = { retractPriceRange: sinon.stub().resolves(), retractXcallRange: sinon.stub().resolves(), retractMatchRange: sinon.stub().resolves() };
        const idx = createMockIndexer({ hubClient });
        idx.protocolChanges = { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) };
        const rb = new Rollback(idx);
        idx.util.resetLists();
        // First query returns an action_index so the rollback has an orphaned range
        idx.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 50 }]);
        idx.indexerDb.doQuery.resolves([]);
        await rb.rollback(100);
        assert.ok(hubClient.retractPriceRange.calledOnce, 'expected retractPriceRange to be called once');
        assert.strictEqual(hubClient.retractPriceRange.firstCall.args[0], rb.config['COIN']);
        assert.strictEqual(hubClient.retractPriceRange.firstCall.args[1], 50);
    });

    it('does NOT signal the hub when there are no actions in the rolled-back range', async function () {
        const hubClient = { retractPriceRange: sinon.stub().resolves(), retractXcallRange: sinon.stub().resolves(), retractMatchRange: sinon.stub().resolves() };
        const idx = createMockIndexer({ hubClient });
        idx.protocolChanges = { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) };
        const rb = new Rollback(idx);
        idx.util.resetLists();
        idx.indexerDb.doQuery.resolves([]); // no action_index found
        await rb.rollback(100);
        assert.ok(hubClient.retractPriceRange.notCalled, 'expected no retraction when range is empty');
    });

    it('does not throw when the hub retraction fails (best-effort)', async function () {
        const hubClient = { retractPriceRange: sinon.stub().rejects(new Error('hub unreachable')), retractXcallRange: sinon.stub().resolves(), retractMatchRange: sinon.stub().resolves() };
        const idx = createMockIndexer({ hubClient });
        idx.protocolChanges = { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) };
        const rb = new Rollback(idx);
        idx.util.resetLists();
        idx.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 50 }]);
        idx.indexerDb.doQuery.resolves([]);
        await assert.doesNotReject(() => rb.rollback(100));
        assert.ok(idx.indexerDb.commitTransaction.calledOnce, 'local rollback should still commit');
    });

    // ─── Hub XCALL (cross_chain_calls) retraction signal ──────────────

    it('signals the hub to retract cross-chain calls for the rolled-back range', async function () {
        const hubClient = { retractPriceRange: sinon.stub().resolves(), retractXcallRange: sinon.stub().resolves(), retractMatchRange: sinon.stub().resolves() };
        const idx = createMockIndexer({ hubClient });
        idx.protocolChanges = { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) };
        const rb = new Rollback(idx);
        idx.util.resetLists();
        idx.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 50 }]);
        idx.indexerDb.doQuery.resolves([]);
        await rb.rollback(100);
        assert.ok(hubClient.retractXcallRange.calledOnce, 'expected retractXcallRange to be called once');
        assert.strictEqual(hubClient.retractXcallRange.firstCall.args[0], rb.config['COIN']);
        assert.strictEqual(hubClient.retractXcallRange.firstCall.args[1], 50);
    });

    it('does NOT signal the hub for XCALL retraction when the range is empty', async function () {
        const hubClient = { retractPriceRange: sinon.stub().resolves(), retractXcallRange: sinon.stub().resolves(), retractMatchRange: sinon.stub().resolves() };
        const idx = createMockIndexer({ hubClient });
        idx.protocolChanges = { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) };
        const rb = new Rollback(idx);
        idx.util.resetLists();
        idx.indexerDb.doQuery.resolves([]);
        await rb.rollback(100);
        assert.ok(hubClient.retractXcallRange.notCalled, 'expected no XCALL retraction when range is empty');
    });

    it('does not throw when the hub XCALL retraction fails (best-effort); local rollback still commits', async function () {
        const hubClient = { retractPriceRange: sinon.stub().resolves(), retractXcallRange: sinon.stub().rejects(new Error('hub unreachable')), retractMatchRange: sinon.stub().resolves() };
        const idx = createMockIndexer({ hubClient });
        idx.protocolChanges = { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) };
        const rb = new Rollback(idx);
        idx.util.resetLists();
        idx.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 50 }]);
        idx.indexerDb.doQuery.resolves([]);
        await assert.doesNotReject(() => rb.rollback(100));
        assert.ok(idx.indexerDb.commitTransaction.calledOnce, 'local rollback should still commit');
    });

    // ─── Hub DEX (cross_chain_matches) retraction signal ──────────────

    it('signals the hub to retract cross-chain matches for the rolled-back range', async function () {
        const hubClient = { retractPriceRange: sinon.stub().resolves(), retractXcallRange: sinon.stub().resolves(), retractMatchRange: sinon.stub().resolves() };
        const idx = createMockIndexer({ hubClient });
        idx.protocolChanges = { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) };
        const rb = new Rollback(idx);
        idx.util.resetLists();
        idx.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 50 }]);
        idx.indexerDb.doQuery.resolves([]);
        await rb.rollback(100);
        assert.ok(hubClient.retractMatchRange.calledOnce, 'expected retractMatchRange to be called once');
        assert.strictEqual(hubClient.retractMatchRange.firstCall.args[0], rb.config['COIN']);
        assert.strictEqual(hubClient.retractMatchRange.firstCall.args[1], 50);
    });

    it('does NOT signal the hub for DEX match retraction when the range is empty', async function () {
        const hubClient = { retractPriceRange: sinon.stub().resolves(), retractXcallRange: sinon.stub().resolves(), retractMatchRange: sinon.stub().resolves() };
        const idx = createMockIndexer({ hubClient });
        idx.protocolChanges = { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) };
        const rb = new Rollback(idx);
        idx.util.resetLists();
        idx.indexerDb.doQuery.resolves([]);
        await rb.rollback(100);
        assert.ok(hubClient.retractMatchRange.notCalled, 'expected no DEX match retraction when range is empty');
    });

    it('does not throw when the hub DEX match retraction fails (best-effort); local rollback still commits', async function () {
        const hubClient = { retractPriceRange: sinon.stub().resolves(), retractXcallRange: sinon.stub().resolves(), retractMatchRange: sinon.stub().rejects(new Error('hub unreachable')) };
        const idx = createMockIndexer({ hubClient });
        idx.protocolChanges = { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) };
        const rb = new Rollback(idx);
        idx.util.resetLists();
        idx.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 50 }]);
        idx.indexerDb.doQuery.resolves([]);
        await assert.doesNotReject(() => rb.rollback(100));
        assert.ok(idx.indexerDb.commitTransaction.calledOnce, 'local rollback should still commit');
    });

    // ─── Transaction wrapping ─────────────────────────────────────────

    it('calls beginTransaction at the start of rollback', async function () {
        // Return no action_indexes so the DELETE phase is minimal
        indexer.indexerDb.doQuery.resolves([]);
        await rollback.rollback(100);
        assert.ok(indexer.indexerDb.beginTransaction.calledOnce);
    });

    it('calls commitTransaction on success', async function () {
        indexer.indexerDb.doQuery.resolves([]);
        await rollback.rollback(100);
        assert.ok(indexer.indexerDb.commitTransaction.calledOnce);
    });

    it('does NOT call rollbackTransaction on success', async function () {
        indexer.indexerDb.doQuery.resolves([]);
        await rollback.rollback(100);
        assert.ok(indexer.indexerDb.rollbackTransaction.notCalled);
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

    // ─── DELETE queries issued ────────────────────────────────────────

    it('issues DELETE queries for blockTables using block_index', async function () {
        indexer.indexerDb.doQuery.resolves([]);
        await rollback.rollback(100);
        const queries = indexer.indexerDb.doQuery.args.map(a => a[0]);
        const blockDeletes = queries.filter(q => q && q.includes('DELETE FROM') && q.includes('block_index'));
        assert.ok(blockDeletes.length >= rollback.blockTables.length,
            `Expected at least ${rollback.blockTables.length} block_index DELETE queries, got ${blockDeletes.length}`);
    });

    it('issues DELETE queries for dataTables when firstActionIndex exists', async function () {
        // First query returns an action_index so DELETE phase runs
        indexer.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 50 }]);
        indexer.indexerDb.doQuery.resolves([]);
        await rollback.rollback(100);
        const queries = indexer.indexerDb.doQuery.args.map(a => a[0]);
        const actionDeletes = queries.filter(q => q && q.includes('DELETE FROM') && q.includes('action_index'));
        assert.ok(actionDeletes.length > 0, 'Expected action_index DELETE queries when firstActionIndex exists');
    });

    // ─── Post-rollback updates ────────────────────────────────────────

    it('calls updateBalances after rollback', async function () {
        indexer.indexerDb.doQuery.resolves([]);
        await rollback.rollback(100);
        assert.ok(indexer.indexerDb.updateBalances.calledOnce);
    });

    it('calls updateTokens after rollback', async function () {
        indexer.indexerDb.doQuery.resolves([]);
        await rollback.rollback(100);
        assert.ok(indexer.indexerDb.updateTokens.calledOnce);
    });

    it('calls updateMarkets after rollback', async function () {
        indexer.indexerDb.doQuery.resolves([]);
        await rollback.rollback(100);
        assert.ok(indexer.indexerDb.updateMarkets.calledOnce);
    });

    it('calls sanityCheck after rollback', async function () {
        indexer.indexerDb.doQuery.resolves([]);
        await rollback.rollback(100);
        assert.ok(indexer.indexerDb.sanityCheck.calledOnce);
    });

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

    it('resets terminal attestation requests whose flip happened in the orphaned range', async function () {
        indexer.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 50 }]);
        indexer.indexerDb.doQuery.resolves([]);
        await rollback.rollback(100);

        const updateQuery = attestationResetUpdate();
        assert.ok(updateQuery, 'expected a companion UPDATE resetting the v0 request row request_status to pending');
        // Keyed on resolved_block (recorded at flip time), so BOTH terminal paths
        // reset: a v1 response (fulfilled/errored) AND a v2 expiry (expired) — the
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

    it('does NOT issue the request_status reset when there is no orphaned range', async function () {
        indexer.indexerDb.doQuery.resolves([]); // no firstActionIndex
        await rollback.rollback(100);
        assert.ok(!attestationResetUpdate(), 'no reset UPDATE expected when the rolled-back range is empty');
    });

    // ─── Ownership-escrow reset (reorg correctness) ───────────────────
    //
    // Regression for: a reorg that orphans an ORDER/SWAP/DISPENSER carrying
    // GIVE_OWNERSHIP must clear the surviving token's escrow_action_index. The
    // forward path stamps the token row (created by a much earlier ISSUE, so it
    // survives) with the offer's action_index. The offer row is bulk-deleted in
    // the orphaned range, but the token recompute never touches the escrow
    // column — so without a companion UPDATE the surviving token keeps pointing
    // at a now-deleted offer and isOwnershipEscrowed() permanently returns true,
    // rejecting every owner-only action while a from-genesis replay (where the
    // offer was never re-mined) accepts them. The stamp IS the offer's
    // action_index, so the reset is keyed on firstActionIndex (>= is exact).

    function escrowResetUpdate() {
        const queries = indexer.indexerDb.doQuery.args.map(a => a[0]);
        return queries.find(q =>
            q &&
            /UPDATE\s+tokens/i.test(q) &&
            /escrow_action_index\s*=\s*NULL/i.test(q)
        );
    }

    it('resets orphaned ownership-escrow stamps on surviving token rows', async function () {
        indexer.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 50 }]);
        indexer.indexerDb.doQuery.resolves([]);
        await rollback.rollback(100);

        const updateQuery = escrowResetUpdate();
        assert.ok(updateQuery, 'expected a companion UPDATE clearing escrow_action_index on surviving token rows');
        // Keyed on escrow_action_index >= firstActionIndex — the stamp IS the
        // offer's action_index, so this clears only escrows whose owning offer
        // falls in the orphaned range and leaves surviving escrows untouched.
        assert.ok(/escrow_action_index\s*>=\s*\?/i.test(updateQuery),
            'escrow reset UPDATE should be keyed on escrow_action_index >= firstActionIndex');
        // The bound argument is firstActionIndex (the offer's action_index), NOT
        // the rollback target block — escrow stamps live in action_index space.
        const call = indexer.indexerDb.doQuery.args.find(a => a[0] === updateQuery);
        assert.deepStrictEqual(call[1], [50], 'escrow reset UPDATE should be parameterised with firstActionIndex');
    });

    it('does NOT issue the escrow reset when there is no orphaned range', async function () {
        indexer.indexerDb.doQuery.resolves([]); // no firstActionIndex
        await rollback.rollback(100);
        assert.ok(!escrowResetUpdate(), 'no escrow reset UPDATE expected when the rolled-back range is empty');
    });
});
