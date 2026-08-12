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

    it('blockTables contains anchor_reward_reconcile_log so orphaned reconcile-log rows are pruned', function () {
        assert.ok(rollback.blockTables.includes('anchor_reward_reconcile_log'));
    });

    it('restores reconcile-deleted anchor validator_rewards from anchor_reward_reconcile_log before the deletes (RB-ANCHOR)', async function () {
        indexer.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 50 }]); // firstActionIndex
        indexer.indexerDb.doQuery.resolves([]);
        await rollback.rollback(100);
        const calls = indexer.indexerDb.doQuery.getCalls();
        const restore = calls.find(c =>
            /INSERT IGNORE INTO validator_rewards/.test(c.args[0]) &&
            c.args[0].includes('anchor_reward_reconcile_log'));
        assert.ok(restore, 'expected an anchor_reward_reconcile_log restore into validator_rewards');
        // Scoped to reconciles being orphaned (block_index >= reorg) that deleted losers whose
        // ORIGINAL earn-block SURVIVES the reorg (reward_block_index < reorg). Both params = reorg.
        assert.ok(/d\.block_index\s*>=\s*\?/.test(restore.args[0]), 'must scope on the reconcile block');
        assert.ok(/d\.reward_block_index\s*<\s*\?/.test(restore.args[0]), 'must only restore losers whose earn-block survives the reorg');
        assert.deepStrictEqual(restore.args[1], [100, 100, 100]);
        // Must precede the generic validator_rewards block delete (log rows must still exist).
        const restoreIdx = calls.indexOf(restore);
        const deleteIdx = calls.findIndex(c => /DELETE FROM validator_rewards WHERE block_index/.test(c.args[0]));
        assert.ok(restoreIdx >= 0 && deleteIdx >= 0 && restoreIdx < deleteIdx, 'reconcile restore must run before the validator_rewards delete');
    });

    // ─── / materialization-block scoping ───────────
    //
    // An derived anchor reward is EARNED at the checkpoint's snapshot_block S but
    // MATERIALIZED while the BTC indexer processes a later block B. Scoping the reorg delete
    // on block_index alone leaves the row alive for any reorg height in (S, B], i.e. a
    // COLLECT-spendable credit a from-genesis replay to that height has not derived yet.

    it('deletes validator_rewards by derive_block_index too, so a reward materialized in the orphaned range goes', async function () {
        indexer.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 50 }]); // firstActionIndex
        indexer.indexerDb.doQuery.resolves([]);
        await rollback.rollback(100);
        const calls = indexer.indexerDb.doQuery.getCalls();
        const del = calls.find(c => /DELETE FROM validator_rewards WHERE derive_block_index\s*>=\s*\?/.test(c.args[0]));
        assert.ok(del, 'expected a validator_rewards delete scoped on the MATERIALIZATION block');
        assert.deepStrictEqual(del.args[1], [100]);
        // Must run before the index_addresses/index_tickers deletes: those remove ids this
        // table still references, so any surviving row pointing at them would dangle.
        const delIdx   = calls.indexOf(del);
        const indexIdx = calls.findIndex(c => /DELETE FROM index_addresses WHERE block_index/.test(c.args[0]));
        assert.ok(indexIdx >= 0, 'expected the index_addresses rollback delete');
        assert.ok(delIdx < indexIdx, 'the derive-block delete must precede the index-lookup deletes');
    });

    it('does NOT restore a reconcile loser that was itself materialized inside the orphaned range', async function () {
        indexer.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 50 }]); // firstActionIndex
        indexer.indexerDb.doQuery.resolves([]);
        await rollback.rollback(100);
        const restore = indexer.indexerDb.doQuery.getCalls().find(c =>
            /INSERT IGNORE INTO validator_rewards/.test(c.args[0]) &&
            c.args[0].includes('anchor_reward_reconcile_log'));
        assert.ok(restore, 'expected the RB-ANCHOR restore');
        const sql = restore.args[0];
        // The earn-block test alone would restore a loser derived in the orphaned range, minting
        // an orphan the replay never has. NULL keeps the pre- same-block-writer behavior.
        assert.ok(/d\.reward_derive_block_index IS NULL OR d\.reward_derive_block_index\s*<\s*\?/.test(sql),
            'restore must also require the loser MATERIALIZATION block to survive the reorg');
        assert.ok(/derive_block_index/.test(sql.split('SELECT')[0]),
            'restore must carry derive_block_index back onto the restored row');
        assert.ok(/d\.reward_derive_block_index/.test(sql.split('FROM')[0]),
            'restore must project the logged materialization block, not NULL');
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

    it('feeds the reversed-maturity source address + tick into the balance/supply recompute', async function () {
        // The reversed unstake rows live in surviving blocks (action_index < firstActionIndex),
        // so the read-phase scan never collected them. The reversal block must pre-scan them and
        // feed (address, GAS) / (address, tick) into updateBalances/updateTokens, or the deleted
        // refund credit lingers in the cached balance + token supply (the 4608 divergence).
        indexer.indexerDb.doQuery.callsFake(async (query) => {
            if (/FROM\s+actions\s+a/i.test(query) && /a\.action_index/i.test(query)) return [{ action_index: 50 }];
            // Capability maturity pre-scan: SELECT ... FROM unstakes u ... cooldown_end_block
            if (query.includes('FROM unstakes u') && query.includes('cooldown_end_block') && /SELECT/i.test(query)) return [{ address: 'capSrc' }];
            // Contract maturity pre-scan: SELECT ... FROM contract_unstakes cu ... cooldown_end_block
            if (query.includes('FROM contract_unstakes cu') && query.includes('cooldown_end_block') && /SELECT/i.test(query)) return [{ address: 'conSrc', tick: 'CTICK' }];
            return [];
        });

        await rollback.rollback(100);

        const balanceArg = indexer.indexerDb.updateBalances.firstCall.args[0];
        assert.ok(balanceArg.includes('capSrc'), 'updateBalances should receive the capability unstake source address');
        assert.ok(balanceArg.includes('conSrc'), 'updateBalances should receive the contract unstake source address');
        const tokenArg = indexer.indexerDb.updateTokens.firstCall.args[0];
        assert.ok(tokenArg.includes('XCHAIN'), 'updateTokens should receive GAS for the capability maturity refund');
        assert.ok(tokenArg.includes('CTICK'), 'updateTokens should receive the contract unstake tick');
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
        const hubClient = { enabled: true, retractPriceRange: sinon.stub().resolves(), retractXcallRange: sinon.stub().resolves(), retractMatchRange: sinon.stub().resolves() };
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
        const hubClient = { enabled: true, retractPriceRange: sinon.stub().resolves(), retractXcallRange: sinon.stub().resolves(), retractMatchRange: sinon.stub().resolves() };
        const idx = createMockIndexer({ hubClient });
        idx.protocolChanges = { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) };
        const rb = new Rollback(idx);
        idx.util.resetLists();
        idx.indexerDb.doQuery.resolves([]); // no action_index found
        await rb.rollback(100);
        assert.ok(hubClient.retractPriceRange.notCalled, 'expected no retraction when range is empty');
    });

    it('does not throw when the hub retraction fails (best-effort)', async function () {
        const hubClient = { enabled: true, retractPriceRange: sinon.stub().rejects(new Error('hub unreachable')), retractXcallRange: sinon.stub().resolves(), retractMatchRange: sinon.stub().resolves() };
        const idx = createMockIndexer({ hubClient });
        idx.protocolChanges = { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) };
        const rb = new Rollback(idx);
        idx.util.resetLists();
        idx.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 50 }]);
        idx.indexerDb.doQuery.resolves([]);
        await assert.doesNotReject(() => rb.rollback(100));
        assert.ok(idx.indexerDb.commitTransaction.calledOnce, 'local rollback should still commit');
    });

    it('leaves the durable write-ahead price_retraction row when the live RPC fails (HUB-RETRACT-2)', async function () {
        const hubClient = { enabled: true, retractPriceRange: sinon.stub().rejects(new Error('hub unreachable')), retractXcallRange: sinon.stub().resolves(), retractMatchRange: sinon.stub().resolves() };
        const idx = createMockIndexer({ hubClient });
        idx.protocolChanges = { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) };
        // Distinct ids per staged row so we can tell which was delivered.
        let n = 0; idx.indexerDb.enqueueHubPushTx = sinon.stub().callsFake(async () => ++n);
        idx.indexerDb.markHubPushDelivered = sinon.stub().resolves();
        const rb = new Rollback(idx);
        idx.util.resetLists();
        idx.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 50 }]);
        idx.indexerDb.doQuery.resolves([]);
        await assert.doesNotReject(() => rb.rollback(100));
        // The retraction was write-ahead-staged (durable) as a closed-range price_retraction row.
        const priceStage = idx.indexerDb.enqueueHubPushTx.getCalls().find(c => c.args[0] === 'price_retraction');
        assert.ok(priceStage, 'a durable price_retraction row must be write-ahead-staged');
        assert.strictEqual(priceStage.args[1].coin, rb.config['COIN']);
        assert.strictEqual(priceStage.args[1].action_index, 50);
        // Its row (id 1) must NOT be marked delivered, since the live RPC failed - it stays for the queue.
        assert.ok(!idx.indexerDb.markHubPushDelivered.getCalls().some(c => c.args[0] === 1),
            'a failed live delivery must leave the durable row for HubPushQueue');
    });

    // ─── Closed-range deferred retraction + quiesce (items 5296/5297) ──

    it('write-aheads the durable retraction with last_action_index = MAX of the rolled-back range (closed range)', async function () {
        const hubClient = { enabled: true, retractPriceRange: sinon.stub().rejects(new Error('hub unreachable')), retractXcallRange: sinon.stub().resolves(), retractMatchRange: sinon.stub().resolves() };
        const idx = createMockIndexer({ hubClient });
        idx.protocolChanges = { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) };
        const rb = new Rollback(idx);
        idx.util.resetLists();
        idx.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 50 }]);   // firstActionIndex
        idx.indexerDb.doQuery.onSecondCall().resolves([{ last_action_index: 75 }]); // MAX(action_index)
        idx.indexerDb.doQuery.resolves([]);
        await assert.doesNotReject(() => rb.rollback(100));
        const payload = idx.indexerDb.enqueueHubPushTx.getCalls().find(c => c.args[0] === 'price_retraction').args[1];
        assert.strictEqual(payload.action_index, 50);
        assert.strictEqual(payload.last_action_index, 75, 'durable write-ahead retraction must carry the closed-range ceiling');
        // The durable payload also carries the pre-bump generation fence (item 5308); the mock bump
        // returns 1, so the pre-bump value is 0.
        assert.strictEqual(payload.retraction_generation, 0, 'durable write-ahead retraction must carry the generation fence');
    });

    it('keeps the LIVE retraction open-ended (no ceiling) so it never under-deletes the orphaned range', async function () {
        const hubClient = { enabled: true, retractPriceRange: sinon.stub().resolves(), retractXcallRange: sinon.stub().resolves(), retractMatchRange: sinon.stub().resolves() };
        const idx = createMockIndexer({ hubClient });
        idx.protocolChanges = { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) };
        const rb = new Rollback(idx);
        idx.util.resetLists();
        idx.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 50 }]);
        idx.indexerDb.doQuery.onSecondCall().resolves([{ last_action_index: 75 }]);
        idx.indexerDb.doQuery.resolves([]);
        await rb.rollback(100);
        // Live call passes (coin, from, null, retractionGeneration): the ceiling is intentionally
        // omitted (open-ended), but the generation fence (item 5308) IS threaded. The mock bump
        // returns 1, so the pre-bump retraction generation is 0.
        assert.strictEqual(hubClient.retractPriceRange.firstCall.args[1], 50);
        assert.strictEqual(hubClient.retractPriceRange.firstCall.args[2], null, 'no closed-range ceiling on the live retraction');
        assert.strictEqual(hubClient.retractPriceRange.firstCall.args[3], 0, 'pre-bump generation threaded as the fence');
    });

    it('bumps the push generation once at rollback start and threads the PRE-bump value (item 5308)', async function () {
        const hubClient = { enabled: true, retractPriceRange: sinon.stub().resolves(), retractXcallRange: sinon.stub().resolves(), retractMatchRange: sinon.stub().resolves() };
        const idx = createMockIndexer({ hubClient });
        idx.protocolChanges = { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) };
        idx.indexerDb.bumpPushGeneration = sinon.stub().resolves(6);   // post-bump generation 6 => pre-bump 5
        const rb = new Rollback(idx);
        idx.util.resetLists();
        idx.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 50 }]);
        idx.indexerDb.doQuery.resolves([]);
        await rb.rollback(100);
        assert.ok(idx.indexerDb.bumpPushGeneration.calledOnce, 'generation bumped exactly once');
        assert.strictEqual(idx.indexerDb.bumpPushGeneration.firstCall.args[0], rb.config['COIN']);
        // All three retractions carry the pre-bump generation (5) as the fence.
        assert.strictEqual(hubClient.retractPriceRange.firstCall.args[3], 5);
        assert.strictEqual(hubClient.retractXcallRange.firstCall.args[3], 5);
        assert.strictEqual(hubClient.retractMatchRange.firstCall.args[3], 5);
    });

    it('quiesces the hub-push queue around the retraction block (pause before, resume after, even on throw)', async function () {
        const order = [];
        const hubPushQueue = {
            pause:  sinon.stub().callsFake(() => order.push('pause')),
            resume: sinon.stub().callsFake(() => order.push('resume'))
        };
        // A failing live retraction must still resume() via the finally.
        const hubClient = {
            enabled: true,
            retractPriceRange: sinon.stub().callsFake(async () => { order.push('retract'); throw new Error('hub down'); }),
            retractXcallRange: sinon.stub().resolves(),
            retractMatchRange: sinon.stub().resolves()
        };
        const idx = createMockIndexer({ hubClient });
        idx.protocolChanges = { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) };
        idx.indexerDb.enqueueHubPush = sinon.stub().resolves();
        idx.hubPushQueue = hubPushQueue;   // captured by the Rollback constructor
        const rb = new Rollback(idx);
        idx.util.resetLists();
        idx.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 50 }]);
        idx.indexerDb.doQuery.resolves([]);
        await assert.doesNotReject(() => rb.rollback(100));
        assert.ok(hubPushQueue.pause.calledOnce && hubPushQueue.resume.calledOnce, 'pause + resume each called once');
        assert.ok(order.indexOf('pause') < order.indexOf('retract'), 'pause precedes retraction');
        assert.ok(order.indexOf('retract') < order.indexOf('resume'), 'resume follows retraction');
    });

    // ─── Hub XCALL (cross_chain_calls) retraction signal ──────────────

    it('signals the hub to retract cross-chain calls for the rolled-back range', async function () {
        const hubClient = { enabled: true, retractPriceRange: sinon.stub().resolves(), retractXcallRange: sinon.stub().resolves(), retractMatchRange: sinon.stub().resolves() };
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
        const hubClient = { enabled: true, retractPriceRange: sinon.stub().resolves(), retractXcallRange: sinon.stub().resolves(), retractMatchRange: sinon.stub().resolves() };
        const idx = createMockIndexer({ hubClient });
        idx.protocolChanges = { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) };
        const rb = new Rollback(idx);
        idx.util.resetLists();
        idx.indexerDb.doQuery.resolves([]);
        await rb.rollback(100);
        assert.ok(hubClient.retractXcallRange.notCalled, 'expected no XCALL retraction when range is empty');
    });

    it('does not throw when the hub XCALL retraction fails (best-effort); local rollback still commits', async function () {
        const hubClient = { enabled: true, retractPriceRange: sinon.stub().resolves(), retractXcallRange: sinon.stub().rejects(new Error('hub unreachable')), retractMatchRange: sinon.stub().resolves() };
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
        const hubClient = { enabled: true, retractPriceRange: sinon.stub().resolves(), retractXcallRange: sinon.stub().resolves(), retractMatchRange: sinon.stub().resolves() };
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
        const hubClient = { enabled: true, retractPriceRange: sinon.stub().resolves(), retractXcallRange: sinon.stub().resolves(), retractMatchRange: sinon.stub().resolves() };
        const idx = createMockIndexer({ hubClient });
        idx.protocolChanges = { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) };
        const rb = new Rollback(idx);
        idx.util.resetLists();
        idx.indexerDb.doQuery.resolves([]);
        await rb.rollback(100);
        assert.ok(hubClient.retractMatchRange.notCalled, 'expected no DEX match retraction when range is empty');
    });

    it('does not throw when the hub DEX match retraction fails (best-effort); local rollback still commits', async function () {
        const hubClient = { enabled: true, retractPriceRange: sinon.stub().resolves(), retractXcallRange: sinon.stub().resolves(), retractMatchRange: sinon.stub().rejects(new Error('hub unreachable')) };
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

    it('feeds action-empty-range cooldown sources into the recompute (null firstActionIndex)', async function () {
        indexer.indexerDb.doQuery.callsFake(async (query) => {
            // No actions in the range -> firstActionIndex null.
            if (/FROM\s+actions\s+a/i.test(query) && /a\.action_index/i.test(query)) return [];
            if (query.includes('FROM unstakes u') && query.includes('cooldown_end_block') && /SELECT/i.test(query)) return [{ address: 'capSrc' }];
            if (query.includes('FROM contract_unstakes cu') && query.includes('cooldown_end_block') && /SELECT/i.test(query)) return [{ address: 'conSrc', tick: 'CTICK' }];
            return [];
        });
        await rollback.rollback(100);
        const balanceArg = indexer.indexerDb.updateBalances.firstCall.args[0];
        assert.ok(balanceArg.includes('capSrc') && balanceArg.includes('conSrc'),
            'updateBalances must receive the reversed-maturity sources even on an action-empty range');
        const tokenArg = indexer.indexerDb.updateTokens.firstCall.args[0];
        assert.ok(tokenArg.includes('XCHAIN') && tokenArg.includes('CTICK'),
            'updateTokens must receive GAS + the contract tick even on an action-empty range');
    });

    // ─── REORG-2: consensus range reads use the throw-on-fault variant ──────────
    it('reads firstActionIndex / lastActionIndex via doQueryStrict (fault must abort, not empty)', async function () {
        // The mock aliases doQueryStrict to the doQuery stub, so assert the range reads went
        // through the strict entry point by making it throw and confirming rollback propagates.
        const idx = createMockIndexer();
        idx.protocolChanges = { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) };
        const rb = new Rollback(idx);
        idx.util.resetLists();
        idx.indexerDb.doQueryStrict = sinon.stub().rejects(new Error('lock wait timeout'));
        idx.indexerDb.beginTransaction = sinon.stub().resolves();
        let threw = false;
        try { await rb.rollback(100); } catch(e){ threw = true; }
        assert.ok(threw, 'a fault on the strict range read must abort the rollback');
        assert.ok(idx.indexerDb.beginTransaction.notCalled, 'no transaction (hence no delete) may begin after a failed range read');
    });

    // ─── HUB-RETRACT-6 / HUB-RETRACT-1: a failed push-generation bump rolls the transaction back ─────
    // With the bump failed there is no fence value that can separate a re-published row (at a
    // recycled action_index) from an orphan, so degrading to an un-fenced retraction would wipe
    // canonical rows. The bump now runs INSIDE the rollback transaction (before commit), so a failure
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

    // ─── HUB-RETRACT-1: the fence bump is issued inside the transaction, before commit ─────
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

    // ─── HUB-RETRACT-2: retractions are write-ahead-staged in-tx, then delivered + dropped on success ─────
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

    // ─── IDX-1: anchor invalid_archive reset interns 'unverified' before the UPDATE ─────
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

    // ─── the anchor invalid_archive reset covers BOTH archive-head versions (v1 + v6) ─────
    it('widens the anchor invalid_archive reset predicate to the archive-head version set IN (1, 6)', async function () {
        const { ARCHIVE_HEAD_VERSIONS, ARCHIVE_HEAD_VERSIONS_SQL } = require('../../src/stateHash.js');
        assert.deepStrictEqual(ARCHIVE_HEAD_VERSIONS, [1, 6], 'shared archive-head set must be [1, 6]');
        indexer.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 50 }]); // firstActionIndex
        indexer.indexerDb.doQuery.resolves([]);
        indexer.indexerDb.createStatus = sinon.stub().resolves(1);
        await rollback.rollback(100);
        const anchorUpdate = indexer.indexerDb.doQuery.getCalls().find(c =>
            /UPDATE anchor_actions p/.test(c.args[0]) && /status = 'invalid_archive'/.test(c.args[0]));
        assert.ok(anchorUpdate, 'expected the anchor invalid_archive reset UPDATE');
        assert.ok(anchorUpdate.args[0].includes('p.version ' + ARCHIVE_HEAD_VERSIONS_SQL),
            'the reset must select archive-head parents via the shared IN (1, 6) predicate, ' +
            'or a reorg-orphaned v6 archive batch stays wedged invalid_archive permanently');
        assert.ok(!/p\.version = 1\b/.test(anchorUpdate.args[0]),
            'the legacy v1-only predicate must be gone from the reset UPDATE');
    });

    // ─── PRICE-SNAP-1: price_snapshots delete is reference_chain-qualified and BTC-only ─────
    it('qualifies the price_snapshots reorg delete by reference_chain and runs it only on BTC', async function () {
        // Mock config coin is BTC.
        indexer.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 50 }]);
        indexer.indexerDb.doQuery.resolves([]);
        await rollback.rollback(100);
        const psDelete = indexer.indexerDb.doQuery.getCalls().find(c => /DELETE FROM price_snapshots/.test(c.args[0]));
        assert.ok(psDelete, 'BTC indexer should issue the price_snapshots delete');
        assert.ok(/reference_chain = 'BTC'/.test(psDelete.args[0]),
            'the delete must be qualified by reference_chain so it cannot prune an off-BTC-published round');
    });

    it('does NOT delete price_snapshots on a non-BTC (DOGE) indexer', async function () {
        const idx = createMockIndexer();
        idx.config['COIN'] = 'DOGE';
        idx.protocolChanges = { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) };
        const rb = new Rollback(idx);
        idx.util.resetLists();
        idx.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 50 }]);
        idx.indexerDb.doQuery.resolves([]);
        await rb.rollback(100);
        assert.ok(!idx.indexerDb.doQuery.getCalls().some(c => /DELETE FROM price_snapshots/.test(c.args[0])),
            'a DOGE indexer must not run the BTC-anchored price_snapshots delete');
    });

    // ─── IDX-2: markets zombie (pair first-traded only in the orphaned range, ticks survive) ─────
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
