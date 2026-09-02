/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 *********************************************************************/

/*
 * test/unit/recoveryRewardDeriveBlock.test.js
 *
 * A recovery-restored anchor/archive reward must be indistinguishable from a live-derived
 * one to the reorg-scoping delete.
 *
 * A live derivation writes TWO heights (anchor_reward_derive.js): block_index = the
 * checkpoint's snapshot_block (the earn block, where the stake source resolves) and
 * derive_block_index = the BTC block that actually minted the row. rollback.js scopes its
 * validator_rewards delete on BOTH, because a reward whose CREATING block is orphaned is one
 * a from-genesis replay to that height has not derived yet; leaving it in place is a
 * COLLECT-spendable credit no live node still holds, i.e. a larger SUM(validator_rewards) at
 * the next COLLECT, which is a ledger fork.
 *
 * The recovery restore wrote NO derive_block_index, so a restored row was invisible to the
 * derive-scoped delete and survived every reorg in (earn, derive]. Operator ruling (a),
 * 2026-08-29: the restored row claims THE BLOCK IT WAS FIRST DERIVED AT, never the
 * height recovery happened to re-apply it at. That height is deterministic and needs no new
 * archive field: the fleet-agreed watermark makes every node mint a mirrored attestation's
 * reward at snapshot_block + ANCHOR_REWARD_MIRROR_MATURITY.
 *
 * These tests pin: the stamp itself, the height a restored reward may first appear at (the
 * same one a live node derives it at), the untouched pre-flag-day behaviour, and the
 * reorg-scoping outcome for a live-derived and a restored row side by side.
 */

'use strict';

const assert   = require('assert');
const Database = require('../../src/db');
const ar       = require('../../src/anchor_reward_activation.js');

const MATURITY = ar.ANCHOR_REWARD_MIRROR_MATURITY;
const PUB      = 'ab'.repeat(32);
const SOURCE   = 'bc1qAlice';

// ─── In-memory stand-in for the three tables the apply path touches ───────────────────
//
// Routes the production SQL to arrays so the real Database methods run unmodified. Only the
// statements this path issues are handled; anything else returns [] (and would surface as a
// failed assertion downstream rather than a silent pass).
function makeDb({ network = 'regtest', staged = [], addressBlock = 1 } = {}) {
    const rewards = [];
    const stagedRows = staged.map((s, i) => ({
        id: i + 1, source_address: s.source_address || SOURCE, validator_pubkey: s.validator_pubkey || PUB,
        reward_type: s.reward_type || 'anchor_BTC', round_reference: s.round_reference || 42,
        amount: s.amount || '10.00000000', block_index: s.block_index,
        applied: 0, source_id: null, applied_block: null
    }));
    const db = {
        config: { NETWORK: network, COIN: 'BTC' },
        rewards, stagedRows,
        _recoveryPendingChecked: false,
        _recoveryPendingRemaining: 0,
        async getOrCreatePubkeyId(){ return 9; },
        async doQuery(sql, params){
            if(/SELECT COUNT\(\*\) AS c FROM recovery_pending_rewards/.test(sql))
                return [{ c: stagedRows.filter(r => r.applied === 0).length }];
            if(/FROM recovery_pending_rewards WHERE source_address=\? AND applied=0/.test(sql))
                return stagedRows.filter(r => r.applied === 0 && r.source_address === params[0]);
            if(/JOIN index_addresses ia ON ia\.address = rpr\.source_address/.test(sql)){
                // The due sweep: only block-stamped (deterministic) ids, only due earn-blocks.
                if(addressBlock === null) return [];
                let seen = new Set();
                return stagedRows
                    .filter(r => r.applied === 0 && Number(r.block_index) <= Number(params[0]))
                    .filter(r => (seen.has(r.source_address) ? false : (seen.add(r.source_address), true)))
                    .map(r => ({ source_address: r.source_address, source_id: 5 }));
            }
            if(/INSERT IGNORE INTO validator_rewards/.test(sql)){
                rewards.push({ source_id: params[0], signing_pubkey_id: params[1], reward_type: params[2],
                               round_reference: params[3], round_qualifier: params[4], amount: params[5],
                               block_index: params[6], derive_block_index: params[7] });
                return { affectedRows: 1 };
            }
            if(/UPDATE recovery_pending_rewards SET applied=1/.test(sql)){
                let row = stagedRows.find(r => r.id === params[2]);
                if(row){ row.applied = 1; row.source_id = params[0]; row.applied_block = params[1]; }
                return { affectedRows: row ? 1 : 0 };
            }
            return [];
        },
        _probeRecoveryPending:          Database.prototype._probeRecoveryPending,
        _restoredRewardDeriveBlock:     Database.prototype._restoredRewardDeriveBlock,
        _applyPendingRewardsForAddress: Database.prototype._applyPendingRewardsForAddress,
        _applyPendingRewardsDueAtBlock: Database.prototype._applyPendingRewardsDueAtBlock,
        _maybeApplyPendingRewards:      Database.prototype._maybeApplyPendingRewards
    };
    return db;
}

// The reorg-scoping delete rollback.js issues against validator_rewards, as one predicate:
// the block_index (earn) sweep of blockTables, then the derive_block_index sweep. Kept
// beside the tests that use it; test/unit/rollback.test.js pins that rollback.js really
// issues both, with these bounds and in this order.
function reorgScopingDelete(rows, reorgBlock){
    return rows.filter(r =>
        !(Number(r.block_index) >= reorgBlock) &&
        !(r.derive_block_index !== null && r.derive_block_index !== undefined &&
          Number(r.derive_block_index) >= reorgBlock));
}

describe('recovery-restored rewards claim their ORIGINAL derive block @regression @tier1', function () {

    it('stamps derive_block_index = earn-block + the frozen mirror maturity', async function () {
        const earn = 800000;
        const db = makeDb({ staged: [{ block_index: earn }] });
        const n = await db._applyPendingRewardsDueAtBlock(earn + MATURITY);
        assert.strictEqual(n, 1, 'the due row materializes');
        assert.strictEqual(db.rewards.length, 1);
        assert.strictEqual(db.rewards[0].block_index, earn, 'earn-block carried verbatim');
        assert.strictEqual(db.rewards[0].derive_block_index, earn + MATURITY,
            'the restored row must claim the height the live fleet derived it at');
        // Same value the live derivation stamps: deriveAnchorRewards passes the BTC block it
        // is processing, and a row is not fetched before snapshot_block + MATURITY, so the
        // earliest (and, because a node that cannot prove the anchor DEFERS the block rather
        // than skipping the row, the only) minting height is exactly this one.
        assert.strictEqual(db.rewards[0].derive_block_index, ar.anchorRewardDeriveHeight(earn));
    });

    it('does NOT materialize before that height: the createAddress hook leaves it staged', async function () {
        const earn = 800000;
        const db = makeDb({ staged: [{ block_index: earn }] });
        // The source address is interned at or before its own STAKE, hence at or below the
        // earn block, hence a whole maturity window below the derive height: the intern
        // hook can never be the trigger for a derive-era row.
        await db._maybeApplyPendingRewards(SOURCE, 5, 12345);
        assert.strictEqual(db.rewards.length, 0, 'nothing may be credited before the derive height');
        assert.strictEqual(db.stagedRows[0].applied, 0, 'the row stays staged for the due sweep');
    });

    it('the due sweep lands it in exactly the derive block, not the one before', async function () {
        const earn = 800000;
        const db = makeDb({ staged: [{ block_index: earn }] });
        assert.strictEqual(await db._applyPendingRewardsDueAtBlock(earn + MATURITY - 1), 0);
        assert.strictEqual(db.rewards.length, 0);
        assert.strictEqual(await db._applyPendingRewardsDueAtBlock(earn + MATURITY), 1);
        assert.strictEqual(db.rewards.length, 1);
        assert.strictEqual(db.stagedRows[0].applied, 1);
        assert.strictEqual(db.stagedRows[0].applied_block, earn + MATURITY,
            'applied_block is the landing block, the forward-window key xchain-sync streams by');
    });

    it('is idempotent: a second sweep at a later block adds nothing', async function () {
        const earn = 800000;
        const db = makeDb({ staged: [{ block_index: earn }] });
        await db._applyPendingRewardsDueAtBlock(earn + MATURITY);
        await db._applyPendingRewardsDueAtBlock(earn + MATURITY + 50);
        assert.strictEqual(db.rewards.length, 1);
    });

    it('below the derive flag-day the stamp stays NULL and the address hook still lands it', async function () {
        // mainnet's derive activation is the inert null placeholder: no BTC-side row was ever
        // minted by the derive path there, so the legacy behaviour must be byte-identical.
        const db = makeDb({ network: 'mainnet', staged: [{ block_index: 800000 }] });
        await db._maybeApplyPendingRewards(SOURCE, 5, 12345);
        assert.strictEqual(db.rewards.length, 1, 'the pre-flag-day row lands at the address hook, as before');
        assert.strictEqual(db.rewards[0].derive_block_index, null, 'no derive stamp below the flag-day');
        assert.strictEqual(db.stagedRows[0].applied_block, 12345);
    });

    it('an unknown/absent network is treated as inert (fail-closed to the legacy stamp)', async function () {
        const db = makeDb({ network: '', staged: [{ block_index: 800000 }] });
        await db._maybeApplyPendingRewards(SOURCE, 5, 900);
        assert.strictEqual(db.rewards.length, 1);
        assert.strictEqual(db.rewards[0].derive_block_index, null);
    });

    it('an early chain cannot sweep everything in below the maturity window', async function () {
        const db = makeDb({ staged: [{ block_index: 0 }] });
        assert.strictEqual(await db._applyPendingRewardsDueAtBlock(MATURITY - 1), 0);
        assert.strictEqual(db.rewards.length, 0);
    });

    it('costs one COUNT(*) for the process lifetime when nothing is staged', async function () {
        const db = makeDb({ staged: [] });
        let probes = 0;
        const inner = db.doQuery.bind(db);
        db.doQuery = async function (sql, params) {
            if(/SELECT COUNT\(\*\) AS c FROM recovery_pending_rewards/.test(sql)) probes++;
            return inner(sql, params);
        };
        for(let b = 900000; b < 900010; b++) await db._applyPendingRewardsDueAtBlock(b);
        assert.strictEqual(probes, 1, 'the gate probes once and short-circuits every later block');
    });

    // ─── The point of the whole thing ────────────────────────────────────────────────
    it('REORG SCOPING: the same delete that removes a live-derived row removes the restored one',
       async function () {
        const earn   = 800000;
        const derive = earn + MATURITY;
        const db = makeDb({ staged: [{ block_index: earn }] });
        await db._applyPendingRewardsDueAtBlock(derive);
        const restored = db.rewards[0];

        // A live-derived row for the same reward: earn at snapshot_block, minted at the
        // watermark height (anchor_reward_derive.js), on another node's DB.
        const live = { block_index: earn, derive_block_index: derive };

        // A reorg to any height in (earn, derive] orphans the minting block while leaving the
        // earn block below the block_index sweep. Without the derive stamp a restored row
        // survives that window alone, as a COLLECT-spendable credit no live node still has.
        for(const h of [earn + 1, derive - 1, derive]){
            assert.strictEqual(reorgScopingDelete([live], h).length, 0,
                'the live-derived row is removed by a reorg to ' + h);
            assert.strictEqual(reorgScopingDelete([restored], h).length, 0,
                'the restored row must be removed by the very same delete at ' + h);
        }
        // Above the derive block nothing is orphaned, and both rows stay.
        assert.strictEqual(reorgScopingDelete([live], derive + 1).length, 1);
        assert.strictEqual(reorgScopingDelete([restored], derive + 1).length, 1);
    });

    it('re-arm floor: a reorg into (earn, derive] re-arms the staging row it just deleted', function () {
        // The delete above is only half of it. rollback.js must also re-arm the staging row,
        // or the reward is gone from this node for good while the live fleet re-derives it.
        // The floor drops by exactly one maturity window on an armed network.
        assert.strictEqual(ar.restoredRewardRearmFloor(800000 + MATURITY, 'regtest'), 800000);
        assert.strictEqual(ar.restoredRewardRearmFloor(800000 + MATURITY, 'testnet'), 800000);
        // Clamped at the flag-day and at 0, never above the reorg height.
        assert.strictEqual(ar.restoredRewardRearmFloor(10, 'regtest'), 0);
        // An inert network carries no derive stamps, so the floor stays the earn-block sweep.
        assert.strictEqual(ar.restoredRewardRearmFloor(800000, 'mainnet'), 800000);
        assert.strictEqual(ar.restoredRewardRearmFloor(800000, 'nosuchnet'), 800000);
        assert.strictEqual(ar.restoredRewardRearmFloor('not-a-height', 'regtest'), null);
    });

    it('restoredRewardDeriveHeight is the one rule both the stamp and the floor read', function () {
        assert.strictEqual(ar.restoredRewardDeriveHeight(700000, 'regtest'), 700000 + MATURITY);
        assert.strictEqual(ar.restoredRewardDeriveHeight(700000, 'testnet'), 700000 + MATURITY);
        assert.strictEqual(ar.restoredRewardDeriveHeight(700000, 'mainnet'), null);
        assert.strictEqual(ar.restoredRewardDeriveHeight('x', 'regtest'), null);
    });
});
