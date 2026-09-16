/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Indexer - Rollback: block-scoped purge
 *
 * The deletes and restores keyed on block heights, in the order the deletes require:
 * the anchor reward and roll-call repairs that read rows the loops drop, the block and
 * index-id loops, and the recovery reward re-arm that must follow them. Installed onto
 * Rollback.prototype by ./index.js; the statements are in src/db/rollback/purge.js.
 *
 ********************************************************************/

'use strict';

const ar        = require('../consensus/gates/anchor_reward_gate.js');
const purgeSql  = require('../db/rollback/purge.js');

module.exports = {

    // Restore anchor validator_rewards rows an orphaned reconcile DELETEd IN PLACE
    // from earlier SURVIVING blocks (RB-ANCHOR). reconcileAnchorRewardWinner keeps
    // only the smallest-pubkey winner per (reward_type, round_reference); on a
    // failover double-publish it deletes loser rows that were created at the
    // checkpoint's SNAPSHOT_BLOCK (earlier than the ANCHOR that runs the reconcile),
    // logging each pre-image in anchor_reward_reconcile_log keyed to the reconcile's
    // (ANCHOR) block. If that ANCHOR is in the orphaned range, the generic block
    // delete below drops the log rows and the ANCHOR but cannot re-create the deleted
    // losers, leaving the reorged node with a collapsed reward set while a from-genesis
    // replay to reorg_block-1 (reconcile never re-ran) keeps every loser. That lowers
    // a later COLLECT's SUM(validator_rewards) → a ledger-hashed fork. Re-INSERT only
    // losers whose ORIGINAL earn-block (reward_block_index) SURVIVES the reorg
    // (< block_index): a loser earned inside the orphaned range is correctly absent
    // (replay never mints it, and the generic delete already removed any copy). The
    // restored row carries its original earn-block, so the generic block delete (which
    // scopes on block_index >= reorg) leaves it in place. Runs BEFORE that delete so
    // the log rows still exist. amount is the frozen consensus reward constant per
    // round, so duplicate log rows carry an identical value and INSERT IGNORE is
    // value-stable + idempotent (no earliest-debit tiebreak needed, unlike the slash
    // restores above where prev_amount can differ across repeated slashes of one row).
    //
    // Runs UNCONDITIONALLY, OUTSIDE the firstActionIndex guard above (RB-ANCHOR-NULL).
    // The reconcile has two callers and only one of them mints an actions row: the DOGE
    // ANCHOR handler (actions/anchor.js) passes its own action_index, but the BTC-side
    // derive (anchor_reward_derive.js) passes NULL because the attested rows arrive over
    // the mirror, not as a wire action. So a BTC reorg over a range whose only reward
    // work was a derive-side reconcile leaves firstActionIndex null, while the generic
    // blockTables loop below still drops anchor_reward_reconcile_log and the
    // derive_block_index delete below still drops the replacement winner: gated here,
    // the earlier winner would be deleted and never restored, which is exactly the
    // SUM(validator_rewards) divergence this statement exists to prevent. Keyed entirely
    // on block heights (no action-index term), and a no-op when the log holds nothing in
    // range, so running it on every reorg costs one query. Placed immediately past the
    // guard rather than at the top of the transaction so its order relative to every
    // other statement is unchanged; nothing between the guard and the deletes below
    // touches validator_rewards or anchor_reward_reconcile_log.
    //
    // The surviving-earn-block test alone is NOT sufficient once a reward can be
    // MATERIALIZED later than it is earned. An derived anchor reward
    // carries block_index = the checkpoint's SNAPSHOT_BLOCK but is written while the
    // BTC indexer processes a much later block, recorded here as
    // reward_derive_block_index. A loser materialized INSIDE the orphaned range has a
    // surviving earn-block yet must NOT be restored: the replay to reorg_block-1 never
    // ran the derivation, so restoring it would mint an orphan the replay does not have
    // and fork SUM(validator_rewards) in the other direction. Require BOTH heights to
    // survive; NULL (every same-block writer, and every row pre-dating the column)
    // keeps the original earn-block-only behavior.
    // round_qualifier rides the pre-image like every other key column: it is part
    // of the reward's UNIQUE identity (snapshot_block for the archive leg, whose
    // round_reference is a reissuable hub counter), so restoring without it would
    // re-INSERT the loser under qualifier 0 - a DIFFERENT row from the one the
    // reconcile deleted, colliding with whatever legacy row already holds that key
    // and leaving the real loser unrestored.
    async restoreReconciledAnchorRewards(block_index){
        await purgeSql.restoreReconciledAnchorRewards(this.indexerDb, block_index);
    },

    // ROLLCALL eviction repair, and it MUST run before the block-table loop below
    // deletes the rollcall_absences rows it reads.
    //
    // The generic delegations repair above now uses a value threshold and so already
    // covers an eviction stamp (same actionBlock + activationDelay formula), which the
    // earlier self-join on an orphaned DELEGATE-revoke row could not: an eviction writes
    // no revoke row, it stamps every delegation of the source directly, and `evicted = 1`
    // in rollcall_absences is the only record of which sources were stamped, which is
    // exactly why that column exists. This sweep is kept as an idempotent narrower
    // repair, not because the generic one misses it. The stakes side needs nothing here -- the
    // eviction wrote real `unstakes` rows at the close block, so the orphaned-unstake
    // join above already re-NULLs those stamps.
    async repairRollcallEvictions(block_index){
        await purgeSql.repairRollcallEvictions(this.indexerDb, this.config, block_index);
    },

    // The two BTC-side ROLLCALL tables delete on close_block. They are declared
    // rollback: 'special' rather than 'block' because neither has a block_index
    // column, so the generic blockTables loop below would throw 1054 on them and
    // fail the entire rollback transaction on every reorg.
    // Absences before verdicts, so a partial failure cannot leave an absence row
    // pointing at an epoch whose verdict is already gone; the catch swallows ONLY
    // the schema gap on a node that predates the ROLLCALL migration, where the
    // tables do not exist and there is nothing to unwind. This is the ONLY
    // roll-call unwind: xchain-sync/src/client/rollback.js carries the replica's
    // mirror of it, and a second copy here re-raises 1146 on a pre-migration node
    // and aborts the reorg this guard exists to keep alive.
    async unwindRollcallEpochs(block_index){
        await purgeSql.unwindRollcallEpochs(this.indexerDb, block_index);
    },

    // Delete data from tables using block_index
    async purgeBlockScopedTables(block_index){
        await purgeSql.purgeBlockScopedTables(this.indexerDb, this.blockTables, block_index);
    },

    // Second scoping key for validator_rewards: the MATERIALIZATION block. The
    // loop above deletes on block_index, which for a reward is its EARN block.
    // That is the same block for every writer except the BTC-side anchor/archive
    // derivation, which earns at the checkpoint's SNAPSHOT_BLOCK S but
    // creates the row while processing a later BTC block B (stamped derive_block_index).
    // A reorg to any H in (S, B] orphans the block that MINTED the reward while leaving
    // block_index = S below the delete's scope, so the row survived as a COLLECT-
    // spendable credit that a from-genesis replay to H-1 has not derived yet: the next
    // COLLECT reads a larger SUM(validator_rewards) here than on a freshly-synced node,
    // which is a ledger-hashed fork. Deleting on the creating block makes the reorged
    // node match the replay, and the derivation is idempotent, so the row re-materializes
    // when the canonical chain reaches the mirrored attestation again.
    //
    // Runs AFTER the loop (so it also covers a row the earn-block delete already took,
    // as a no-op) and BEFORE the index_addresses/index_tickers deletes below, which
    // require that no surviving row still points at an id they are about to remove.
    // NULL derive_block_index (every same-block writer, and every row written before the
    // column existed) is never matched, so this is byte-neutral until the derive flag-day
    // arms. Wrapped for the schema gap on a node that has not yet taken the column.
    async purgeDerivedRewards(block_index){
        await purgeSql.purgeDerivedRewards(this.indexerDb, block_index);
    },

    // Roll back the index id lookups (index_addresses / index_tickers).
    //
    // These ids became consensus-relevant once an address/ticker can be referenced
    // on the wire as ^<id>: a wire ^<id> is stored verbatim into a *_id column and
    // resolved back to a string at block-hash time, so the SAME ^<id> must name the
    // SAME entity on every node. The ids are assigned by an explicit dense counter
    // (db.getNextAddressId / getNextTickerId), so deleting the ids first seen in the
    // orphaned blocks lets the surviving MAX(id)+1 reproduce them deterministically
    // when the canonical chain is reapplied. (Pre-^id, these tables were intentionally
    // NOT rolled back: their AUTO_INCREMENT ids never rewound and fed no hashed value.
    // That is now a fork vector, so they ARE rolled back.)
    //
    // MUST run AFTER the action_index and block_index data deletes above: every row
    // that referenced an orphaned-block id has already been removed, so no surviving
    // row is left pointing at a deleted id. Rows whose block_index is NULL
    // (pre-migration / never stamped) are never matched and are left untouched.
    async purgeIndexLookups(block_index){
        await purgeSql.purgeIndexLookups(this.indexerDb, this.indexTables, block_index);
    },

    // F1a recovery reward re-arm. validator_rewards is block-scoped and was deleted
    // above by earn-block (block_index >= firstBlockIndex). Re-arm the staging rows for
    // those same earn-blocks so the reward can be re-materialized on the canonical chain.
    // Key on the reward's earn-block (block_index), NOT on whether the source address
    // rolled out: a reward row is dropped iff its earn-block is in the orphaned range,
    // independent of its source address. The common (and easily missed) case is an
    // address first seen BEFORE the range that earns a reward INSIDE it: the reward row
    // is deleted but the address survives, so the old "source_id NOT IN index_addresses"
    // predicate never fired and the reward was silently lost forever. MUST run AFTER the
    // validator_rewards/index_addresses deletes above. No-op (and the table may be absent
    // on a non-recovery stack) outside an in-progress recovery, so it is wrapped cheaply.
    //
    // The floor is NOT the reorg height alone. A restored row carries the
    // MATERIALIZATION block it was first derived at (earn + the frozen mirror
    // maturity), so the derive-scoped delete above takes it whenever that height is
    // orphaned - which happens for earn-blocks a whole maturity window BELOW the reorg
    // point. Re-arming only from the reorg height would leave those rows applied=1 with
    // no validator_rewards row behind them: the reward would be gone from this node for
    // good while the live fleet re-derives it from its mirror when the canonical chain
    // reaches the same height again. restoredRewardRearmFloor drops the floor by exactly
    // the maturity window on a network where derivation is armed, and stays at the reorg
    // height everywhere else (nothing below it can carry a derive stamp).
    async rearmRecoveryRewards(block_index){
        let rearmFloor = ar.restoredRewardRearmFloor(block_index, String(this.config['NETWORK'] || ''));
        if(rearmFloor === null) rearmFloor = block_index;
        await purgeSql.rearmRecoveryRewards(this.indexerDb, rearmFloor, block_index);
    },

};
