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
 * XChain Indexer - Rollback: in-place flip resets and stake restores
 *
 * Undo what an orphaned action wrote IN PLACE on a row that survives the reorg:
 * terminal request, poll and bet flips, deactivation stamps, and the stake amounts
 * and signing keys a slash or a rotation rewrote. Installed onto Rollback.prototype
 * by ./index.js; the statements are in src/db/rollback/in_place_flips.js and
 * src/db/rollback/stake_restores.js.
 *
 ********************************************************************/

'use strict';

const flipsSql   = require('../db/rollback/in_place_flips.js');
const restoreSql = require('../db/rollback/stake_restores.js');

module.exports = {

    // Delete contract_emissions first (references contract_executions)
    async deleteContractEmissions(firstActionIndex){
        await flipsSql.deleteContractEmissions(this.indexerDb, firstActionIndex);
    },

    // Reset ATTEST v0 (request) rows whose TERMINAL flip happened in the
    // orphaned range. The forward path flips a request from 'pending' to
    // 'fulfilled'/'errored' (v1 response) or 'expired' (v2 expiry) via a
    // direct UPDATE on the request row (created in an EARLIER block, so
    // it survives the bulk delete below). Without the reset, the
    // surviving request is stuck non-'pending': a re-applied response is
    // rejected as already-resolved, the contract callback never fires,
    // and, for a reorged expiry, the deadline sweep (pending-only)
    // never re-synthesizes the v2 row, diverging a reorged node from a
    // fresh sync. Keyed on resolved_block (recorded at flip time) so
    // BOTH flip paths reset; this replaced the v1-only self-join, which
    // could not see v2 expiries (they flip without a correlated v1 row).
    async resetOrphanedAttestRequests(block_index){
        await flipsSql.resetOrphanedAttestRequests(this.indexerDb, block_index);
    },

    // Reset XCALL v0 (request) rows whose terminal flip (result callback
    // or deadline expiry) happened in the orphaned range. The flip is a
    // direct UPDATE on the surviving request row, so the bulk delete
    // below can't undo it. Without this reset, a re-applied result row
    // hits the already-resolved interlock and the contract's callback is
    // silently lost (and an expiry never re-arms). Keyed on
    // resolved_block (recorded at flip time) so BOTH flip paths reset.
    async resetOrphanedXcallRequests(block_index){
        await flipsSql.resetOrphanedXcallRequests(this.indexerDb, block_index);
    },

    // Re-open VOTE polls whose TERMINAL finalization happened in the
    // orphaned range. The VOTE v2 sweep flips a poll (created in an
    // EARLIER block, so it survives the bulk delete below) from 'open'
    // to 'finalized'/'failed_quorum' via a direct UPDATE on the polls
    // row, and writes poll_results keyed on the v2 action_index (those
    // ARE deleted generically). Without this reset the surviving polls
    // row stays terminal, so the per-block sweep (open-only) never
    // re-synthesizes the v2 and a reorged node diverges from a fresh
    // sync. Keyed on resolved_block (stamped at finalize) so it re-opens
    // and re-evaluates early-decide on replay. Mirrors the ATTEST reset.
    // deposit_resolved + callback_execute_action_index reset too: the v2
    // escrow release and the injected binding-callback EXECUTE (both at the
    // v2 action_index) are deleted generically with the orphaned range, so
    // the re-synthesized v2 must re-release the escrow and re-fire the
    // callback on replay.
    async reopenOrphanedPolls(block_index){
        await flipsSql.reopenOrphanedPolls(this.indexerDb, block_index);
    },

    // BET in-place flip resets (P4; the polls/attests pattern
    // applied to all three BET stamps). A feed row created in an
    // EARLIER block survives the bulk delete below, but its
    // feed_status_id was flipped in place by the latch pass
    // (closed_block stamp) and/or a terminal path (terminal_block
    // stamp: resolve tx / cancel tx / BET_EXPIRE pass); a bet row
    // likewise flips bet_status_id in place at settlement
    // (settled_block stamp). Without these resets a reorg past a
    // latch block leaves the feed permanently closed (rejecting
    // valid bets on the re-mined chain) and a reorg past a
    // settlement block leaves stakes marked won/lost with their
    // credits deleted - stranded escrow. Reset order matters:
    // (a) terminal feeds whose latch SURVIVES (closed_block below
    //     the reorg point) go back to 'closed';
    // (b) terminal feeds with no surviving latch go back to 'open';
    // (c) any surviving latch stamped in the orphaned range is
    //     un-latched (runs last so feeds reset by (b) also clear
    //     their orphaned closed_block).
    // Status names resolve through index_statuses (bet_feeds/bets
    // store status_id, unlike polls' inline strings); the interned
    // 'open'/'closed' rows are created by the BET handlers, and the
    // resets are no-ops (JOIN misses) before any BET activity.
    async resetOrphanedBetFlips(block_index){
        await flipsSql.resetOrphanedBetFlips(this.indexerDb, block_index);
    },

    // timelock: a DEFERRED binding-callback fire whose due block is
    // orphaned while the finalization itself survives (resolved_block below
    // the reorg point, callback_due_block at/above it). The injected EXECUTE
    // is deleted generically with the orphaned range; re-NULL the fired
    // marker so the sweep re-fires deterministically when the due block
    // replays. The stamped callback_due_block itself is derived state
    // (resolved_block + delay) from a surviving v2, so it stays.
    async resetOrphanedPollCallbacks(block_index){
        await flipsSql.resetOrphanedPollCallbacks(this.indexerDb, block_index);
    },

    // tokens.escrow_action_index (the ownership-escrow gate) is RE-DERIVED below,
    // AFTER the dataTables delete (see rederiveTokenEscrow()). A range reset here
    // could only handle the SET direction (offer orphaned); it cannot handle the
    // CLEAR direction (a surviving offer whose release was orphaned), so the
    // re-derive replaces it entirely.

    // Re-NULL deactivation_block stamps that orphaned UNSTAKE / DELEGATE-revoke
    // actions wrote IN PLACE on surviving parent stake/delegation rows. Each
    // forward handler (createUnstake, the DELEGATE-revoke path,
    // createContractUnstake, the contract-revoke path) marks an ALREADY-ACTIVE
    // parent row (created by a much earlier STAKE/DELEGATE in a surviving block)
    // with deactivation_block = actionBlock + activationDelay. The bulk delete
    // below removes the orphaned action row but cannot undo that in-place UPDATE,
    // so without this reset the surviving parent keeps a non-NULL deactivation_block.
    // Every active-set read gates on (deactivation_block IS NULL OR
    // deactivation_block > currentBlock), so once the new chain passes the stale
    // value the staker/validator silently drops out of the active set on the
    // reorged node while a from-genesis replay keeps it active, a consensus-
    // affecting divergence (capability staking on BTC, contract staking on all chains).
    //
    // The reset must be PRECISE: a surviving UNSTAKE in an earlier block stamps
    // earlierBlock + activationDelay, which can itself land at/after block_index, so
    // a blanket `deactivation_block >= block_index` would wrongly clear legitimately-
    // earned deactivations. We instead match the EXACT value an orphaned action
    // wrote. For the two tables that still record a child action row
    // (stakes↔unstakes, contract_stakes↔contract_unstakes) we JOIN the surviving
    // parent to its orphaned action row on the same keys the forward handler used
    // and require deactivation_block = orphanBlock + activationDelay.
    // `delegations` and `contract_delegations` record NO child row (both revokes are
    // a pure in-place UPDATE), so both are keyed on the value threshold block_index +
    // activationDelay (equivalently precise, because any surviving revoke stamps a
    // strictly smaller value, i.e. survivingBlock < block_index).
    async clearOrphanedDeactivations(block_index){
        let staking         = this.config['STAKING'];
        let activationDelay = Number((staking && staking['ACTIVATION_DELAY_BLOCKS']) ? staking['ACTIVATION_DELAY_BLOCKS'] : this.config['ACTIVATION_DELAY_BLOCKS']);
        await flipsSql.clearOrphanedDeactivations(this.indexerDb, block_index, activationDelay);
    },

    // Restore stake amounts an orphaned SLASH reduced IN PLACE on surviving rows.
    // slashContractStake debits contract_stakes/contract_unstakes.amount on rows
    // from earlier (surviving) blocks and records each debit's pre-slash
    // `prev_amount` in contract_slash_debits. The generic deletes below drop the
    // orphaned debit rows but cannot revert the in-place reduction, so without this
    // a surviving row keeps its slashed amount while a from-genesis replay (slash
    // never re-mined) keeps the original, a consensus-affecting divergence (active
    // stake drives VM staker weighting, quorum eligibility, and cooldown refunds on
    // all chains). We copy back the HIGHEST orphaned `prev_amount` per row: the
    // debits on one stake row form a strictly decreasing chain (every debit takes a
    // positive amount and nothing else raises the column), and the orphaned range is
    // a suffix of that chain, so the maximum IS the value the row held before the
    // first orphaned debit. The position columns alone cannot express that order,
    // because a re-entrant nested EXECUTE slashes FIRST under a HIGHER action_index
    // than its parent frame: ordering on (block_index, execution_index,
    // slash_position) then reads the parent's later debit as the earliest and
    // restores a value one slash short. Those columns stay as the tiebreak for
    // numerically equal amounts, a replay-stable total order the block-hash preimage
    // also uses for contract_emissions; the AUTO_INCREMENT `id` is NOT, and would
    // let two nodes restore a divergent amount. The restore itself is a pure string
    // copy, so the value is byte-identical to the surviving chain's
    // pre-orphaned-slash state and to a fresh replay (no arithmetic / decimal-format
    // drift). Earlier SURVIVING debits (block_index < block_index) are intentionally
    // left applied. Runs BEFORE the deletes so the debit rows and target rows still
    // exist. Byte-identical (whitespace aside) to the xchain-sync replica twin.
    async restoreContractSlashAmounts(block_index){
        await restoreSql.restoreContractSlashAmounts(this.indexerDb, block_index);
    },

    // Restore signing keys an orphaned DELEGATE v1 materialization rewrote IN PLACE
    // on surviving rows. materializeContractDelegations rewrites
    // contract_stakes/contract_unstakes.signing_pubkey_id on rows from earlier
    // (surviving) blocks and records each rewrite's pre-rotation key, with the table
    // it landed on, in contract_delegation_rotations. The
    // generic deletes below drop the orphaned journal rows but cannot revert the
    // UPDATE, so without this a surviving row keeps the rotated key while a
    // from-genesis replay (the DELEGATE never re-mined, or re-mined at a different
    // height) keeps the original - a consensus-affecting divergence, since the key on
    // the row is exactly what the VM stake snapshot, the UNSTAKE aggregate and the
    // SLASH deduction all read. We copy back the EARLIEST orphaned rotation's
    // `prev_signing_pubkey_id` per row (min block_index, then delegation_action_index,
    // both replay-stable; the AUTO_INCREMENT `id` is NOT and would let two nodes
    // restore different keys). Pure id copy, so the restored value is byte-identical
    // to the surviving chain's pre-rotation state. Earlier SURVIVING rotations are
    // intentionally left applied. Runs BEFORE the deletes so both tables still exist.
    async restoreDelegationRotations(block_index){
        await restoreSql.restoreDelegationRotations(this.indexerDb, block_index);
    },

    // Same restore for CAPABILITY-stake equivocation slashes (WI-2 bump 2):
    // slashCapabilityStake reduces stakes/unstakes.amount IN PLACE on surviving
    // rows and logs the pre-slash `prev_amount` in capability_slash_debits. Copy
    // back the EARLIEST orphaned debit's prev_amount per row (min block_index, then
    // slash_action_index tiebreak). This is a pure string copy, byte-identical to the
    // surviving chain and to a from-genesis replay where the SLASH was never
    // re-mined. Earlier SURVIVING debits (block_index < block_index) stay applied.
    // Runs BEFORE the generic deletes so both the debit rows and the target rows
    // still exist.
    //
    // The same-block tiebreak is slash_action_index, NOT the AUTO_INCREMENT `id`:
    // capability slashes are permissionless SLASH WIRE actions, so slash_action_index
    // is a deterministic, replay-stable action_index (assigned by the idempotent
    // compound-key path, not force=true). Ordering by `id` would let two nodes whose
    // AUTO_INCREMENT chains were assigned in a different order (live vs from-genesis
    // replay) restore a different prev_amount on a reorg that retracts a block with
    // ≥2 slashes against one stake row → a stake-weight fork. (The CONTRACT twin in
    // the restore above keys on the same idea: VM-emitted slashes have no wire
    // action_index, so it orders by (execution_index, slash_position), i.e. the EXECUTE's
    // on-chain action_index plus the emission-loop index, the identical deterministic
    // total order the block-hash preimage uses for contract_emissions.)
    async restoreCapabilitySlashAmounts(block_index){
        await restoreSql.restoreCapabilitySlashAmounts(this.indexerDb, block_index);
    },

};
