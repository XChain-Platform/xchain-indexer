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

    // Reset ATTEST requests whose response or expiry was orphaned.
    // Key on resolved_block so both terminal paths reset.
    async resetOrphanedAttestRequests(block_index){
        await flipsSql.resetOrphanedAttestRequests(this.indexerDb, block_index);
    },

    // Reset XCALL requests whose callback or expiry was orphaned.
    // Key on resolved_block so both terminal paths reset.
    async resetOrphanedXcallRequests(block_index){
        await flipsSql.resetOrphanedXcallRequests(this.indexerDb, block_index);
    },

    // Reopen polls whose v2 finalization was orphaned, keyed on resolved_block.
    // Reset deposit and callback stamps so replay releases and fires again.
    async reopenOrphanedPolls(block_index){
        await flipsSql.reopenOrphanedPolls(this.indexerDb, block_index);
    },

    // Reset BET terminal flips before orphaned latches, then settled bets.
    // Restore surviving latches to closed and all other feeds to open.
    async resetOrphanedBetFlips(block_index){
        await flipsSql.resetOrphanedBetFlips(this.indexerDb, block_index);
    },

    // Re-arm a deferred callback whose due block was orphaned but whose poll
    // survived; keep callback_due_block, which the surviving v2 derived.
    async resetOrphanedPollCallbacks(block_index){
        await flipsSql.resetOrphanedPollCallbacks(this.indexerDb, block_index);
    },

    // tokens.escrow_action_index is re-derived after data deletion by
    // rederiveTokenEscrow(); a range reset cannot restore the clear direction.

    // Clear only stamps orphaned actions wrote: an exact child join, or a floor
    // of block_index + delay; a block_index floor erases surviving stamps.
    async clearOrphanedDeactivations(block_index){
        let staking         = this.config['STAKING'];
        let activationDelay = Number((staking && staking['ACTIVATION_DELAY_BLOCKS']) ? staking['ACTIVATION_DELAY_BLOCKS'] : this.config['ACTIVATION_DELAY_BLOCKS']);
        await flipsSql.clearOrphanedDeactivations(this.indexerDb, block_index, activationDelay);
    },

    // Restore each row's highest orphaned prev_amount: a nested EXECUTE slashes
    // under a higher action_index, so positions only break ties, never `id`.
    // The SQL is twinned with xchain-sync (CONTRACT-SLASH-RESTORE-SQL).
    async restoreContractSlashAmounts(block_index){
        await restoreSql.restoreContractSlashAmounts(this.indexerDb, block_index);
    },

    // Restore the earliest orphaned prev_signing_pubkey_id before deletion.
    // Order by block and delegation action index, never an auto-increment id.
    async restoreDelegationRotations(block_index){
        await restoreSql.restoreDelegationRotations(this.indexerDb, block_index);
    },

    // Restore the earliest orphaned capability prev_amount before deletion.
    // Order by block and slash action index, never an auto-increment id.
    async restoreCapabilitySlashAmounts(block_index){
        await restoreSql.restoreCapabilitySlashAmounts(this.indexerDb, block_index);
    },

};
