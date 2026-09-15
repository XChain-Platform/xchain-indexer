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
 * XChain Indexer - Database statements: rollback block-scoped purge
 *
 * The block-keyed deletes, restores and re-arms of the rollback transaction, each one
 * the body of the src/rollback/purge.js method of the same name. The schema-gap
 * guards stay beside the statements they guard, so a pre-migration node degrades
 * exactly where the statement would have raised.
 *
 ********************************************************************/

'use strict';

module.exports = {

    // Reconciled-away anchor reward losers whose earn and derive heights both survive.
    async restoreReconciledAnchorRewards(db, block_index){
        let query, args;
        query = `INSERT IGNORE INTO validator_rewards
                    (source_id, signing_pubkey_id, reward_type, round_reference, round_qualifier,
                     amount, block_index, derive_block_index)
                 SELECT d.source_id, d.signing_pubkey_id, d.reward_type, d.round_reference,
                        d.round_qualifier,
                        d.amount, d.reward_block_index, d.reward_derive_block_index
                   FROM anchor_reward_reconcile_log d
                  WHERE d.block_index >= ?
                    AND d.reward_block_index < ?
                    AND (d.reward_derive_block_index IS NULL OR d.reward_derive_block_index < ?)`;
        args = [block_index, block_index, block_index];
        await db.doQuery(query, args);
    },

    // Delegation stamps a ROLLCALL eviction in the orphaned range wrote.
    async repairRollcallEvictions(db, config, block_index){
        try {
            let rcStaking = config['STAKING'];
            let rcDelay   = Number((rcStaking && rcStaking['ACTIVATION_DELAY_BLOCKS'])
                                   ? rcStaking['ACTIVATION_DELAY_BLOCKS'] : config['ACTIVATION_DELAY_BLOCKS']);
            await db.doQuery(
                `UPDATE delegations d
                    JOIN rollcall_absences ra ON ra.source_id = d.source_id
                    SET d.deactivation_block = NULL
                    WHERE ra.evicted = 1
                      AND ra.close_block >= ?
                      AND d.deactivation_block IS NOT NULL
                      AND d.deactivation_block = ra.close_block + ?`,
                [block_index, rcDelay]);
        } catch(e){
            // Swallow ONLY a genuine schema gap (1054/1146) on a DB that predates the
            // ROLLCALL migration; no eviction can exist on such a node, so there is
            // nothing to repair. Every other fault must surface.
            if(!(e && (e.errno === 1054 || e.errno === 1146))) throw e;
        }
    },

    // The three roll-call tables, deleted on close_block.
    async unwindRollcallEpochs(db, block_index){
        try {
            // Gates before verdicts for the same reason absences are: a gates row is
            // derived at the close it names.
            await db.doQuery(`DELETE FROM rollcall_gates WHERE close_block >= ?`, [block_index]);
            await db.doQuery(`DELETE FROM rollcall_absences WHERE close_block >= ?`, [block_index]);
            await db.doQuery(`DELETE FROM rollcalls WHERE close_block >= ?`, [block_index]);
        } catch(e){
            if(!(e && (e.errno === 1054 || e.errno === 1146))) throw e;
        }
    },

    // Every blockTables row at or above the reorg block.
    async purgeBlockScopedTables(db, blockTables, block_index){
        let query, args;
        for(let table of blockTables){
            query = `DELETE FROM ` + table + ` WHERE block_index >= ?`;
            args  = [block_index];
            await db.doQuery(query, args);
        }
    },

    // validator_rewards materialized in the orphaned range.
    async purgeDerivedRewards(db, block_index){
        try {
            await db.doQuery(
                `DELETE FROM validator_rewards WHERE derive_block_index >= ?`, [block_index]);
        } catch(e){
            // Swallow ONLY a genuine schema gap (1054 unknown column) on a DB that predates
            // the migration; on such a node no derived reward can exist either, so there is
            // nothing to delete. Every other fault (deadlock, lock-wait, killed connection)
            // must propagate so the whole reorg transaction rolls back rather than committing
            // a partial rollback that keeps a spendable reward.
            if(!(e && (e.errno === 1146 || e.errno === 1054))) throw e;
        }
    },

    // index_addresses / index_tickers ids first seen in the orphaned range.
    async purgeIndexLookups(db, indexTables, block_index){
        let query, args;
        for(let table of indexTables){
            query = `DELETE FROM ` + table + ` WHERE block_index >= ?`;
            args  = [block_index];
            await db.doQuery(query, args);
        }
    },

    // Re-arm the recovery staging rows above the floor and re-apply every survivor.
    async rearmRecoveryRewards(db, rearmFloor, block_index){
        try {
            let rearm = await db.doQuery(
                `UPDATE recovery_pending_rewards
                    SET applied=0, source_id=NULL, applied_block=NULL
                  WHERE applied=1 AND block_index >= ?`, [rearmFloor]);
            if(rearm && rearm.affectedRows)
                db._recoveryPendingChecked = false;
            let survivors = await db.doQuery(
                `SELECT DISTINCT rpr.source_address AS source_address, ia.id AS source_id
                   FROM recovery_pending_rewards rpr
                   JOIN index_addresses ia ON ia.address = rpr.source_address
                  WHERE rpr.applied=0`);
            // Re-materialize at the reorg point B (block_index): the survivor's reward
            // earn-block may be < B, so stamp applied_block = B as the forward-window key
            // xchain-sync streams it by (its earn-block sits below the post-reorg window).
            // A row whose ORIGINAL derive height is still ahead of B is left staged by the
            // apply path's due gate and lands again when the replay reaches that height,
            // which is the same block a live node re-derives it at.
            for(let s of (survivors || []))
                await db.applyPendingRewardsForAddress(s.source_address, s.source_id, block_index);
        } catch(e){
            // Swallow ONLY the schema-gap case: recovery_pending_rewards absent on a
            // non-recovery stack (errno 1146 missing table / 1054 missing column), where
            // nothing was staged to re-arm. Every other fault (lock-wait timeout, deadlock,
            // killed connection) must propagate to the outer catch so the whole reorg
            // transaction rolls back and is retried, instead of commitTransaction()
            // persisting a half-re-armed recovery_pending_rewards/validator_rewards set
            // (which forks SUM(validator_rewards) at the next COLLECT). Mirrors the
            // narrow errno gates in xchain-sync's ClientApplier.
            if(!(e && (e.errno === 1146 || e.errno === 1054))) throw e;
        }
    },

};
