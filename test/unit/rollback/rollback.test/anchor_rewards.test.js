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

const Rollback = require('../../../../src/rollback.js');
const ar = require('../../../../src/anchor_reward_activation.js');

// Part of the Rollback suite whose entry is test/unit/rollback.test.js: the anchor
// validator_rewards restores from anchor_reward_reconcile_log, the derive-block
// scoping of the reward delete and of the recovery-reward re-arm floor, and the
// archive-head and price_snapshots resets. The suite title is the entry's, so every
// full test title is unchanged.

let indexer, rollback;

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

    it('restores reconcile-deleted anchor rewards when the orphaned range holds NO actions row (RB-ANCHOR-NULL)', async function () {
        // The BTC-side derive path calls reconcileAnchorRewardWinner with a NULL anchor action
        // index (the attested rows arrive over the mirror, not as a wire action), so a reorg
        // over a range whose only reward work was a derive-side reconcile leaves
        // firstActionIndex null. The generic block deletes still drop the reconcile log and the
        // replacement winner, so gating the restore on firstActionIndex deletes the earlier
        // winner and never restores it: a permanent SUM(validator_rewards) divergence from a
        // from-genesis replay. No onFirstCall stub here, so the actions probe returns [] and
        // firstActionIndex is null.
        indexer.indexerDb.doQuery.resolves([]);
        await rollback.rollback(100);
        const calls = indexer.indexerDb.doQuery.getCalls();
        const restore = calls.find(c =>
            /INSERT IGNORE INTO validator_rewards/.test(c.args[0]) &&
            c.args[0].includes('anchor_reward_reconcile_log'));
        assert.ok(restore, 'the RB-ANCHOR restore must run with no actions in the orphaned range');
        assert.deepStrictEqual(restore.args[1], [100, 100, 100]);
        // Both surviving-height predicates must outlive the hoist, or the restore would mint
        // rows a from-genesis replay never has.
        assert.ok(/d\.reward_block_index\s*<\s*\?/.test(restore.args[0]),
            'earn-block survival predicate must be retained');
        assert.ok(/d\.reward_derive_block_index\s*<\s*\?/.test(restore.args[0]),
            'materialization-block survival predicate must be retained');
        // Still ordered before every delete that destroys its inputs or its output.
        const restoreIdx   = calls.indexOf(restore);
        const blockDelIdx  = calls.findIndex(c => /DELETE FROM validator_rewards WHERE block_index/.test(c.args[0]));
        const deriveDelIdx = calls.findIndex(c => /DELETE FROM validator_rewards WHERE derive_block_index/.test(c.args[0]));
        const logDelIdx    = calls.findIndex(c => /DELETE FROM anchor_reward_reconcile_log WHERE block_index/.test(c.args[0]));
        assert.ok(blockDelIdx >= 0 && restoreIdx < blockDelIdx, 'restore must precede the earn-block delete');
        assert.ok(deriveDelIdx >= 0 && restoreIdx < deriveDelIdx, 'restore must precede the derive-block delete');
        assert.ok(logDelIdx >= 0 && restoreIdx < logDelIdx, 'restore must precede the reconcile-log delete');
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

    it('re-arms recovery-staged rewards from the DERIVE floor, not the reorg height alone', async function () {
        // A recovery-restored reward carries the materialization block it was first
        // derived at (earn + the frozen mirror maturity), so the derive-scoped delete above
        // takes rows whose EARN block sits a whole maturity window below the reorg point.
        // Re-arming only from the reorg height would leave those staging rows applied=1 with
        // no validator_rewards row behind them: lost on this node, while the live fleet
        // re-derives them from its mirror when the canonical chain reaches the height again.
        indexer.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 50 }]); // firstActionIndex
        indexer.indexerDb.doQuery.resolves([]);
        await rollback.rollback(100);
        const rearm = indexer.indexerDb.doQuery.getCalls().find(c =>
            /UPDATE recovery_pending_rewards/.test(c.args[0]));
        assert.ok(rearm, 'expected the recovery-reward re-arm');
        assert.deepStrictEqual(rearm.args[1], [ar.restoredRewardRearmFloor(100, 'regtest')]);
        assert.strictEqual(rearm.args[1][0], 0, 'a reorg to 100 on regtest floors at 0 (100 - maturity, clamped)');
        // Deep enough that the floor is a real subtraction rather than the clamp.
        indexer.indexerDb.doQuery.resetHistory();
        indexer.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 50 }]);
        indexer.indexerDb.doQuery.resolves([]);
        await rollback.rollback(800000);
        const deep = indexer.indexerDb.doQuery.getCalls().find(c =>
            /UPDATE recovery_pending_rewards/.test(c.args[0]));
        assert.deepStrictEqual(deep.args[1], [800000 - ar.ANCHOR_REWARD_MIRROR_MATURITY]);
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

    // ─── the anchor invalid_archive reset selects the shared archive-head version set ─────
    it('selects the anchor invalid_archive reset parents via the shared archive-head set', async function () {
        const { ARCHIVE_HEAD_VERSIONS, ARCHIVE_HEAD_VERSIONS_SQL } = require('../../../../src/stateHash.js');
        assert.deepStrictEqual(ARCHIVE_HEAD_VERSIONS, [1], 'shared archive-head set must be [1]');
        indexer.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 50 }]); // firstActionIndex
        indexer.indexerDb.doQuery.resolves([]);
        indexer.indexerDb.createStatus = sinon.stub().resolves(1);
        await rollback.rollback(100);
        const anchorUpdate = indexer.indexerDb.doQuery.getCalls().find(c =>
            /UPDATE anchor_actions p/.test(c.args[0]) && /status = 'invalid_archive'/.test(c.args[0]));
        assert.ok(anchorUpdate, 'expected the anchor invalid_archive reset UPDATE');
        assert.ok(anchorUpdate.args[0].includes('p.version ' + ARCHIVE_HEAD_VERSIONS_SQL),
            'the reset must select archive-head parents via the shared spliced predicate, ' +
            'or a reorg-orphaned archive batch stays wedged invalid_archive permanently');
        assert.ok(!/p\.version = 1\b/.test(anchorUpdate.args[0]),
            'a hand-written v1-only literal must stay out of the reset UPDATE: the set is ' +
            'one member today and the splice is what carries the next one');
    });

    // ─── price_snapshots delete is reference_chain-qualified and BTC-only ─────
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
});
