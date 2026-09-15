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
 * XChain Indexer - Database statements: rollback stake restores
 *
 * The restores that copy back a stake amount or a signing key an orphaned SLASH or
 * DELEGATE rotation rewrote in place, each one the body of the
 * src/rollback/in_place_flips.js method of the same name, where the ordering argument
 * is stated. Run inside the rollback transaction, before the generic deletes.
 *
 ********************************************************************/

'use strict';

module.exports = {

    // The highest orphaned contract debit's prev_amount, per stake row, on both tables.
    async restoreContractSlashAmounts(db, block_index){
        let query, args;
        for(let slashTbl of ['contract_stakes', 'contract_unstakes']){
            //<CONTRACT-SLASH-RESTORE-SQL>
            query = `UPDATE ` + slashTbl + ` t
                        JOIN contract_slash_debits d ON d.stake_action_index = t.action_index
                        SET t.amount = d.prev_amount
                        WHERE d.target_table = ?
                          AND d.block_index >= ?
                          AND NOT EXISTS (
                              SELECT 1 FROM contract_slash_debits e
                              WHERE e.target_table      = d.target_table
                                AND e.stake_action_index = d.stake_action_index
                                AND e.block_index >= ?
                                AND (CAST(e.prev_amount AS DECIMAL(60,18)) > CAST(d.prev_amount AS DECIMAL(60,18))
                                     OR (CAST(e.prev_amount AS DECIMAL(60,18)) = CAST(d.prev_amount AS DECIMAL(60,18))
                                         AND (e.block_index < d.block_index
                                              OR (e.block_index = d.block_index
                                                  AND (e.execution_index < d.execution_index
                                                       OR (e.execution_index = d.execution_index
                                                           AND e.slash_position < d.slash_position)))))))`;
            //</CONTRACT-SLASH-RESTORE-SQL>
            args = [slashTbl, block_index, block_index];
            await db.doQuery(query, args);
        }
    },

    // The earliest orphaned rotation's prev_signing_pubkey_id, per stake row, on both tables.
    async restoreDelegationRotations(db, block_index){
        let query, args;
        for(let rotTbl of ['contract_stakes', 'contract_unstakes']){
            query = `UPDATE ` + rotTbl + ` t
                        JOIN contract_delegation_rotations r ON r.stake_action_index = t.action_index
                        SET t.signing_pubkey_id = r.prev_signing_pubkey_id
                        WHERE r.target_table = ?
                          AND r.block_index >= ?
                          AND NOT EXISTS (
                              SELECT 1 FROM contract_delegation_rotations e
                              WHERE e.target_table       = r.target_table
                                AND e.stake_action_index = r.stake_action_index
                                AND e.block_index >= ?
                                AND (e.block_index < r.block_index
                                     OR (e.block_index = r.block_index
                                         AND e.delegation_action_index < r.delegation_action_index)))`;
            args = [rotTbl, block_index, block_index];
            await db.doQuery(query, args);
        }
    },

    // The earliest orphaned capability debit's prev_amount, per stake row, on both tables.
    async restoreCapabilitySlashAmounts(db, block_index){
        let query, args;
        for(let slashTbl of ['stakes', 'unstakes']){
            query = `UPDATE ` + slashTbl + ` t
                        JOIN capability_slash_debits d ON d.stake_action_index = t.action_index
                        SET t.amount = d.prev_amount
                        WHERE d.target_table = ?
                          AND d.block_index >= ?
                          AND NOT EXISTS (
                              SELECT 1 FROM capability_slash_debits e
                              WHERE e.target_table      = d.target_table
                                AND e.stake_action_index = d.stake_action_index
                                AND e.block_index >= ?
                                AND (e.block_index < d.block_index
                                     OR (e.block_index = d.block_index AND e.slash_action_index < d.slash_action_index)))`;
            args = [slashTbl, block_index, block_index];
            await db.doQuery(query, args);
        }
    },

};
