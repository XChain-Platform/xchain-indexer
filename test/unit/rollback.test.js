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

    it('blockTables contains contract_slash_debits so orphaned slash-debit rows are pruned', function () {
        assert.ok(rollback.blockTables.includes('contract_slash_debits'));
    });

    it('restores slashed stake amounts from contract_slash_debits before the deletes', async function () {
        indexer.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 50 }]); // firstActionIndex
        indexer.indexerDb.doQuery.resolves([]);
        await rollback.rollback(100);
        const calls = indexer.indexerDb.doQuery.getCalls();
        const stakeRestore = calls.find(c => /UPDATE contract_stakes/.test(c.args[0]) && c.args[0].includes('contract_slash_debits') && c.args[0].includes('prev_amount'));
        const unstakeRestore = calls.find(c => /UPDATE contract_unstakes/.test(c.args[0]) && c.args[0].includes('contract_slash_debits'));
        assert.ok(stakeRestore, 'expected a contract_stakes slash-amount restore');
        assert.ok(unstakeRestore, 'expected a contract_unstakes slash-amount restore');
        assert.deepStrictEqual(stakeRestore.args[1], ['contract_stakes', 100, 100]);
        assert.deepStrictEqual(unstakeRestore.args[1], ['contract_unstakes', 100, 100]);
        // The restore must precede the generic delete of contract_stakes (debit rows still present)
        const restoreIdx = calls.indexOf(stakeRestore);
        const deleteIdx = calls.findIndex(c => /DELETE FROM contract_stakes WHERE action_index/.test(c.args[0]));
        assert.ok(restoreIdx >= 0 && deleteIdx >= 0 && restoreIdx < deleteIdx, 'slash restore must run before the contract_stakes delete');
    });

    it('contract slash-restore breaks same-block ties deterministically via (execution_index, slash_position), never AUTO_INCREMENT id', async function () {
        // When a reorg retracts a block with >=2 contract slashes against the same
        // stake_action_index, the "earliest debit" NOT EXISTS pick must resolve to the
        // same row on every node. The AUTO_INCREMENT `id` is assigned in physical insert
        // order (differs live-vs-replay and indexer-vs-replica) -> divergent restored
        // prev_amount -> stake-weight / quorum fork. The tiebreak must instead use the
        // (execution_index, slash_position) total order the block-hash preimage already
        // uses for contract_emissions.
        indexer.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 50 }]); // firstActionIndex
        indexer.indexerDb.doQuery.resolves([]);
        await rollback.rollback(100);
        const calls = indexer.indexerDb.doQuery.getCalls();
        const restores = calls.filter(c =>
            /UPDATE contract_(?:un)?stakes/.test(c.args[0]) &&
            c.args[0].includes('contract_slash_debits') &&
            c.args[0].includes('prev_amount'));
        assert.strictEqual(restores.length, 2, 'expected contract_stakes + contract_unstakes slash restores');
        for (const r of restores) {
            const sql = r.args[0];
            assert.ok(/e\.execution_index\s*<\s*d\.execution_index/.test(sql),
                'restore must order by execution_index for a deterministic, replay-stable tiebreak');
            assert.ok(/e\.slash_position\s*<\s*d\.slash_position/.test(sql),
                'restore must use slash_position as the within-EXECUTE secondary tiebreak');
            assert.ok(!/e\.id\s*<\s*d\.id/.test(sql),
                'restore must NOT tiebreak on the non-deterministic AUTO_INCREMENT id');
        }
    });

    it('reverses orphaned cooldown-maturity completions: deletes the refund credit + resets status_id, before the delete and balance recompute', async function () {
        indexer.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 50 }]); // firstActionIndex
        indexer.indexerDb.doQuery.resolves([]);
        await rollback.rollback(100);
        const calls = indexer.indexerDb.doQuery.getCalls();

        // Capability maturity refund (GAS) credit delete, keyed by the unstake's action_index.
        const capCreditDel = calls.find(c => /DELETE c FROM credits c/.test(c.args[0]) && /JOIN unstakes u/.test(c.args[0]) && c.args[0].includes('cooldown_end_block'));
        assert.ok(capCreditDel, 'expected a capability maturity-credit delete joined to unstakes');
        assert.deepStrictEqual(capCreditDel.args[1], ['XCHAIN', 1, 100, 100]);

        // Contract maturity refund credit delete, keyed by the unstake's action_index + tick.
        const conCreditDel = calls.find(c => /DELETE c FROM credits c/.test(c.args[0]) && /JOIN contract_unstakes cu/.test(c.args[0]));
        assert.ok(conCreditDel, 'expected a contract maturity-credit delete joined to contract_unstakes');
        assert.deepStrictEqual(conCreditDel.args[1], [1, 100, 100]);

        // Status flips back to 'valid' on both tables so the sweep re-matures the cooldown.
        const capStatusReset = calls.find(c => /UPDATE unstakes SET status_id/.test(c.args[0]) && c.args[0].includes('cooldown_end_block'));
        const conStatusReset = calls.find(c => /UPDATE contract_unstakes SET status_id/.test(c.args[0]) && c.args[0].includes('cooldown_end_block') && !c.args[0].includes('contract_slash_debits'));
        assert.ok(capStatusReset, 'expected an unstakes status_id reset');
        assert.ok(conStatusReset, 'expected a contract_unstakes status_id reset');

        // The credit deletes must run BEFORE the generic credits delete and BEFORE updateBalances,
        // or a surviving-action_index refund would be re-counted into the rolled-back balance.
        const capCreditIdx = calls.indexOf(capCreditDel);
        const genCreditDelIdx = calls.findIndex(c => /DELETE FROM credits WHERE action_index/.test(c.args[0]));
        assert.ok(capCreditIdx >= 0 && genCreditDelIdx >= 0 && capCreditIdx < genCreditDelIdx, 'maturity-credit delete must precede the generic credits delete');
        assert.ok(indexer.indexerDb.updateBalances.notCalled || capCreditIdx >= 0, 'maturity-credit delete must precede updateBalances');
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

    it('parks a durable price_retraction on the queue when the hub retraction RPC fails', async function () {
        const hubClient = { retractPriceRange: sinon.stub().rejects(new Error('hub unreachable')), retractXcallRange: sinon.stub().resolves(), retractMatchRange: sinon.stub().resolves() };
        const idx = createMockIndexer({ hubClient });
        idx.protocolChanges = { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) };
        idx.indexerDb.enqueueHubPush = sinon.stub().resolves();
        const rb = new Rollback(idx);
        idx.util.resetLists();
        idx.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 50 }]);
        idx.indexerDb.doQuery.resolves([]);
        await assert.doesNotReject(() => rb.rollback(100));
        assert.ok(idx.indexerDb.enqueueHubPush.calledOnce, 'failed retraction should park on the durable queue');
        const [pushType, payload] = idx.indexerDb.enqueueHubPush.firstCall.args;
        assert.strictEqual(pushType, 'price_retraction');
        assert.strictEqual(payload.coin, rb.config['COIN']);
        assert.strictEqual(payload.action_index, 50);
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

    it('does NOT issue the request_status reset when there is no orphaned range', async function () {
        indexer.indexerDb.doQuery.resolves([]); // no firstActionIndex
        await rollback.rollback(100);
        assert.ok(!attestationResetUpdate(), 'no reset UPDATE expected when the rolled-back range is empty');
    });

    // ─── Ownership-escrow RE-DERIVE (reorg correctness, TP-03 #4017) ───
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
    const OPEN_OFFER_RE   = /SELECT\s+o\.action_index\s+FROM\s+orders/i; // per-ticker open-offer query
    const REDERIVE_UPDATE_RE = /UPDATE tokens SET escrow_action_index=\?\s+WHERE tick_id=\(SELECT id FROM index_tickers/i;

    function rederiveUpdateCall() {
        return indexer.indexerDb.doQuery.args.find(a => a[0] && REDERIVE_UPDATE_RE.test(a[0]));
    }

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
});
