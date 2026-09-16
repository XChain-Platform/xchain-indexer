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

const Rollback = require('../../../src/rollback/index.js');

let indexer, rollback;

// The rest of the suite lives beside this file under test/unit/rollback.test/, one
// behaviour per part: the anchor-reward restores and derive-block scoping, the hub
// retraction signals, the transaction and recovery-reward re-arm paths, the
// cooldown-maturity reversal and its recompute, and the attestation reset with the
// ownership-escrow re-derive. This file keeps the table lists, the stake and
// signing-key restores, the index-id deletes, the delete coverage of dataTables,
// the post-rollback updates and the markets zombie. Every part repeats the suite
// title below, so each full test title is unchanged.

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

    it('blockTables contains contract_delegation_rotations so orphaned rotation-journal rows are pruned', function () {
        assert.ok(rollback.blockTables.includes('contract_delegation_rotations'));
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

    it('restores signing keys an orphaned DELEGATE v1 materialization rewrote, before the deletes', async function () {
        // materializeContractDelegations rewrites contract_stakes.signing_pubkey_id IN PLACE on
        // surviving rows. The generic delete drops the orphaned journal rows but cannot
        // revert the UPDATE, so the reorg must copy prev_signing_pubkey_id back or this node
        // hands contracts a different staker set than a from-genesis replay does.
        indexer.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 50 }]); // firstActionIndex
        indexer.indexerDb.doQuery.resolves([]);
        await rollback.rollback(100);
        const calls    = indexer.indexerDb.doQuery.getCalls();
        const restores = calls.filter(c => /UPDATE contract_(?:un)?stakes/.test(c.args[0]) &&
                                        c.args[0].includes('contract_delegation_rotations') &&
                                        c.args[0].includes('prev_signing_pubkey_id'));
        assert.strictEqual(restores.length, 2,
            'the sweep rotates both stake-ledger tables (cooldown rows stay slashable), so both restore');
        const restore = restores[0];
        assert.deepStrictEqual(restore.args[1], ['contract_stakes', 100, 100]);
        assert.deepStrictEqual(restores[1].args[1], ['contract_unstakes', 100, 100]);
        // Same-block ties resolve on delegation_action_index (replay-stable), never the
        // AUTO_INCREMENT id, which is assigned in physical insert order and differs
        // live-vs-replay and indexer-vs-replica.
        assert.ok(/e\.delegation_action_index\s*<\s*r\.delegation_action_index/.test(restore.args[0]),
            'restore must tiebreak on delegation_action_index');
        assert.ok(!/e\.id\s*<\s*r\.id/.test(restore.args[0]), 'must not tiebreak on the AUTO_INCREMENT id');
        const restoreIdx = calls.indexOf(restore);
        const deleteIdx  = calls.findIndex(c => /DELETE FROM contract_stakes WHERE action_index/.test(c.args[0]));
        assert.ok(restoreIdx >= 0 && deleteIdx >= 0 && restoreIdx < deleteIdx,
            'key restore must run before the contract_stakes delete');
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
            // The pick follows the debit chain's own values (highest orphaned prev_amount =
            // the amount before the first orphaned debit). The position columns invert under
            // a re-entrant nested EXECUTE and serve only as the tiebreak for equal amounts;
            // rollback_slash_restore_order.test.js executes both cases against a real engine.
            assert.ok(/CAST\(e\.prev_amount AS DECIMAL\(60,18\)\)\s*>\s*CAST\(d\.prev_amount AS DECIMAL\(60,18\)\)/.test(sql),
                'restore must pick the highest orphaned prev_amount, not the lowest position key');
            assert.ok(/e\.execution_index\s*<\s*d\.execution_index/.test(sql),
                'restore must order by execution_index for a deterministic, replay-stable tiebreak');
            assert.ok(/e\.slash_position\s*<\s*d\.slash_position/.test(sql),
                'restore must use slash_position as the within-EXECUTE secondary tiebreak');
            assert.ok(!/e\.id\s*<\s*d\.id/.test(sql),
                'restore must NOT tiebreak on the non-deterministic AUTO_INCREMENT id');
        }
    });

    it('blockTables contains anchor_reward_reconcile_log so orphaned reconcile-log rows are pruned', function () {
        assert.ok(rollback.blockTables.includes('anchor_reward_reconcile_log'));
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

    it('deletes index_addresses and index_tickers by block_index, after the data deletes (#4904)', async function () {
        // index_addresses/index_tickers ids are consensus-relevant (wire ^<id> refs), so the
        // reorg must delete the ids first seen in orphaned blocks (WHERE block_index >= ?) so a
        // reapply reproduces them deterministically. The coverage guard only asserts list
        // membership; this pins the actual delete predicate + ordering so a refactor that drops
        // the bound, mis-scopes it, or moves it before the data deletes fails red.
        indexer.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 50 }]); // firstActionIndex
        indexer.indexerDb.doQuery.resolves([]);
        await rollback.rollback(100);
        const calls = indexer.indexerDb.doQuery.getCalls();
        const sql   = calls.map(c => c.args[0]);
        const addrIdx = sql.findIndex(q => /DELETE FROM index_addresses WHERE block_index >= \?/.test(q));
        const tickIdx = sql.findIndex(q => /DELETE FROM index_tickers WHERE block_index >= \?/.test(q));
        assert.ok(addrIdx >= 0, 'index_addresses must be deleted by block_index on rollback');
        assert.ok(tickIdx >= 0, 'index_tickers must be deleted by block_index on rollback');
        assert.deepStrictEqual(calls[addrIdx].args[1], [100], 'index_addresses delete bound to the rollback block_index');
        assert.deepStrictEqual(calls[tickIdx].args[1], [100], 'index_tickers delete bound to the rollback block_index');
        // Ordering: the index-id deletes MUST run after the block data deletes (otherwise a
        // surviving row could still point at a to-be-deleted id). Use the blocks delete as the
        // data-phase reference.
        const blocksIdx = sql.findIndex(q => /DELETE FROM blocks WHERE block_index >= \?/.test(q));
        assert.ok(blocksIdx >= 0, 'sanity: blocks delete present');
        assert.ok(addrIdx > blocksIdx && tickIdx > blocksIdx, 'index-id deletes must run after the block data deletes');
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

    it('issues DELETE queries for dataTables when firstActionIndex exists', async function () {
        // First query returns an action_index so DELETE phase runs
        indexer.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 50 }]);
        indexer.indexerDb.doQuery.resolves([]);
        await rollback.rollback(100);
        const queries = indexer.indexerDb.doQuery.args.map(a => a[0]);
        const actionDeletes = queries.filter(q => q && q.includes('DELETE FROM') && q.includes('action_index'));
        assert.ok(actionDeletes.length > 0, 'Expected action_index DELETE queries when firstActionIndex exists');
    });

    it('issues an action_index DELETE for every table in dataTables (set coverage, not just a nonzero count)', async function () {
        // A bare "length > 0" check (see the test above) passes even if 79 of 80
        // dataTables are silently skipped; this asserts the SET of tables actually
        // deleted covers every declared dataTables entry.
        indexer.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 50 }]);
        indexer.indexerDb.doQuery.resolves([]);
        await rollback.rollback(100);
        const queries = indexer.indexerDb.doQuery.args.map(a => a[0]).filter(q => q && typeof q === 'string');
        const deletedTables = new Set();
        for (const q of queries) {
            const m = q.match(/DELETE FROM\s+`?(\w+)`?\s+WHERE\s+(?:\w+\.)?action_index/i);
            if (m) deletedTables.add(m[1]);
        }
        const missing = rollback.dataTables.filter(t => !deletedTables.has(t));
        assert.deepStrictEqual(missing, [],
            `Every dataTables entry must appear in an action_index DELETE; missing: ${missing.join(', ')}`);
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

    // ─── Markets zombie (pair first-traded only in the orphaned range, ticks survive) ─────
    it('deletes a zombie markets row whose only orders were orphaned but whose ticks survive', async function () {
        // Read phase: an ORDER pair (give_tick_id 7 / get_tick_id 9) is collected; both ticks survive.
        indexer.indexerDb.doQuery.callsFake(async (query) => {
            if (/FROM\s+actions\s+a/i.test(query) && /a\.action_index/i.test(query)) return [{ action_index: 50 }];
            // read-phase orders/order_matches collection returns the pair
            if (/FROM\s+orders\s+m|FROM\s+order_matches\s+m/i.test(query) && /m\.give_tick_id/i.test(query))
                return [{ tick1_id: 7, tick2_id: 9 }];
            // survival probes (SELECT 1 FROM orders / order_matches) return empty => zombie
            return [];
        });
        await rollback.rollback(100);
        const zombieDelete = indexer.indexerDb.doQuery.getCalls().find(c =>
            /DELETE FROM markets WHERE \(tick1_id=\? AND tick2_id=\?\)/.test(c.args[0]));
        assert.ok(zombieDelete, 'expected a per-pair zombie markets delete');
        assert.deepStrictEqual(zombieDelete.args[1], [7, 9, 9, 7], 'both orientations of the collected pair must be deleted');
    });
});
