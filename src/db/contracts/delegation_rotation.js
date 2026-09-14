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
 * XChain Indexer - Database mixin part: contracts / delegation_rotation
 *
 * DELEGATE v1 signing-key rotations: materializing them onto contract_stakes and
 * contract_unstakes, reverting revoked ones, and their reorg-restore journal.
 * Merged into the contracts mixin by db/contracts.js, which db/index.js installs
 * onto Database.prototype, so call sites stay this.db.<method>().
 *
 ********************************************************************/

module.exports = {

    // Materialize matured DELEGATE v1 signing-key rotations onto contract_stakes (#4366,
    // gated by CONTRACT_DELEGATION_MATERIALIZE; the caller,
    // utility.processContractDelegationMaterializations, owns the gate).
    //
    // WHY THIS EXISTS. DELEGATE v1 wrote contract_delegations and stopped there, but all THREE
    // contract-stake lookup surfaces key on contract_stakes.signing_pubkey_id:
    // getContractStakeDataForVM (what a contract sees through getStake/getStakers/
    // getTotalStaked), getActiveContractStakeByPubkey (the UNSTAKE refund aggregate) and
    // slashContractStake (the SLASH deduction). So a rotated key owned nothing: it never
    // appeared in getStakers, and a SLASH against it deducted zero while the contract recorded
    // the punishment. Rewriting the key HERE, on the row itself, is what makes the three
    // surfaces agree - remapping only the reads would leave SLASH naming a key the ledger
    // cannot debit, which is strictly worse than the coherent gap it replaces.
    //
    // WHEN. Called once per block, BEFORE the block's transactions, so a rotation is visible to
    // everything in its activation block; that matches the `activation_block <= blockIndex`
    // semantics every other contract-stake read uses. Runs inside the block transaction, so the
    // rewrites and their journal rows commit (or roll back) with the block.
    //
    // WHICH ROWS. One delegation GOVERNS each (target, source, tick) slot: the matured, un-revoked
    // delegation with the greatest (activation_block, action_index). Selecting all matured
    // delegations instead would let two live delegations rewrite the same rows in opposite
    // directions on every block forever. Its key is written to every valid, never-unstaked
    // contract_stakes row on that slot, INCLUDING rows still inside their activation delay: a
    // pending top-up left on the old key would surface as a second, phantom staker under the old
    // pubkey the moment it activates.
    //
    // BOTH STAKE TABLES. The still-slashable contract_unstakes rows on the slot rotate too, even
    // though nothing shows them to a contract. slashContractStake Pass 2 finds cooldown-locked
    // tokens by (target, pubkey, tick); leaving those rows on the old key while the contract is
    // shown the new one would let the cooldown-locked portion of a rotated staker's balance
    // escape every slash - a rotation would become a way to shield funds. 'completed' rows are
    // skipped: they were already refunded and are not slashable. The cooldown sweep keys on
    // action_index/source, never on the pubkey, so refunds are unaffected.
    //
    // REVOKE. DELEGATE v3 ends a delegation's authority (deactivation_block). A slot whose
    // rotation was revoked and has no other governing delegation is reverted to the key the
    // stake was created with, read back from the FIRST journal row for that stake row - a
    // revoked (typically compromised) key must not keep owning the stake in the VM snapshot.
    // The revert is skipped, deterministically, when another source has since claimed that
    // pubkey on any contract stake or delegation: merging two owners under one pubkey would
    // fold them into a single staker entry in the VM snapshot. Such a claim is only possible
    // because the DELEGATE v1 / STAKE v3 collision checks do not reserve a pre-rotation key;
    // reserving it is a separate validity change and would need its own flag-day.
    //
    // DETERMINISM. Every ordering key is replay-stable (block_index, activation_block,
    // action_index); the AUTO_INCREMENT journal id is never ordered on. Returns the applied
    // rotations (audit/tests); an empty array is the common case.
    async materializeContractDelegations(currentBlock){
        let applied  = [];
        let valid_id = await this.getStatusId('valid');
        if(valid_id === null) return applied;
        let block = Number(currentBlock);

        // 1. Governing delegations: matured, not revoked as-of this block, and the LATEST such
        //    delegation for their (target, source, tick) slot.
        let govQuery = `SELECT d.action_index, d.source_id, d.signing_pubkey_id,
                               d.target_contract_index, d.tick_id
                        FROM contract_delegations d
                        WHERE d.status_id=? AND d.tick_id IS NOT NULL
                          AND d.activation_block <= ?
                          AND (d.deactivation_block IS NULL OR d.deactivation_block > ?)
                          AND NOT EXISTS (
                              SELECT 1 FROM contract_delegations d2
                              WHERE d2.target_contract_index = d.target_contract_index
                                AND d2.source_id             = d.source_id
                                AND d2.tick_id               = d.tick_id
                                AND d2.status_id             = ?
                                AND d2.activation_block     <= ?
                                AND (d2.deactivation_block IS NULL OR d2.deactivation_block > ?)
                                AND (d2.activation_block > d.activation_block
                                     OR (d2.activation_block = d.activation_block
                                         AND d2.action_index > d.action_index)))
                        ORDER BY d.activation_block ASC, d.action_index ASC`;
        let governing = await this.doQuery(govQuery, [valid_id, block, block, valid_id, block, block]);

        // The cooldown table's slashable statuses mirror slashContractStake Pass 2 exactly
        // ('valid' plus 'pending'); a 'completed' row was already refunded and cannot be slashed,
        // so rewriting its key would be noise in the journal.
        let pending_id       = await this.getStatusId('pending');
        let unstakeStatusIds = (pending_id === null) ? [valid_id] : [valid_id, pending_id];

        // Slots under an active delegation; the revert pass below must leave these alone.
        let governedSlots = await rotationPasses.rotateGoverned(this, governing, valid_id, unstakeStatusIds, block, applied);

        await rotationPasses.revertUngoverned(this, governedSlots, valid_id, unstakeStatusIds, block, applied);
        return applied;
    },

    // True when `pubkeyId` is held by a contract stake outside this (target, source, tick) slot,
    // or by any active contract delegation. Guards the revert pass: handing a slot back its
    // original key while someone else holds that key would merge two owners into one staker
    // entry in the VM snapshot.
    async contractPubkeyClaimedElsewhere(pubkeyId, slotRow, validStatusId){
        let stakeRows = await this.doQuery(
            `SELECT 1 FROM contract_stakes
             WHERE signing_pubkey_id=? AND status_id=?
               AND NOT (target_contract_index=? AND source_id=? AND tick_id=?)
             LIMIT 1`,
            [pubkeyId, validStatusId, Number(slotRow.target_contract_index), slotRow.source_id, slotRow.tick_id]);
        if(stakeRows.length > 0) return true;
        let delegationRows = await this.doQuery(
            `SELECT 1 FROM contract_delegations
             WHERE signing_pubkey_id=? AND status_id=? AND deactivation_block IS NULL
             LIMIT 1`,
            [pubkeyId, validStatusId]);
        return delegationRows.length > 0;
    },

    // Append a signing-key rotation to the reorg-restore journal. Mirrors
    // createContractSlashDebit: prev_signing_pubkey_id is copied back verbatim on rollback, so
    // the restored value is byte-identical to a from-genesis replay's.
    async createContractDelegationRotation(targetTable, delegationActionIndex, stakeActionIndex, prevPubkeyId, newPubkeyId, blockIndex){
        let query = `INSERT INTO contract_delegation_rotations
                        (target_table, delegation_action_index, stake_action_index,
                         prev_signing_pubkey_id, new_signing_pubkey_id, block_index)
                     VALUES (?, ?, ?, ?, ?, ?)`;
        await this.doQuery(query, [String(targetTable), Number(delegationActionIndex), Number(stakeActionIndex),
            Number(prevPubkeyId), Number(newPubkeyId), Number(blockIndex)]);
    },

};

// The two passes of materializeContractDelegations, kept off the exported object so
// Database.prototype gains no method. Both append every rotation they apply to `applied`.
const rotationPasses = {

    // Step 1, per governing delegation: rotate its slot's stake and cooldown rows onto the
    // delegated key. Returns the governed slot keys the revert pass must leave alone.
    async rotateGoverned(db, governing, valid_id, unstakeStatusIds, block, applied){
        let unstakePlace     = unstakeStatusIds.map(() => '?').join(',');
        let governedSlots = new Set();
        for(let d of governing){
            governedSlots.add(String(d.target_contract_index) + '|' + String(d.source_id) + '|' + String(d.tick_id));
            // Rows that already carry the delegated key are skipped, so a materialized rotation
            // is a no-op on every later block (and writes no further journal rows).
            let stakeRows = await db.doQuery(
                `SELECT action_index, signing_pubkey_id FROM contract_stakes
                 WHERE target_contract_index=? AND source_id=? AND tick_id=? AND status_id=?
                   AND deactivation_block IS NULL
                   AND signing_pubkey_id<>?
                 ORDER BY action_index ASC`,
                [Number(d.target_contract_index), d.source_id, d.tick_id, valid_id, d.signing_pubkey_id]);
            for(let row of stakeRows)
                applied.push(await db.rotateContractStakeKey('contract_stakes', row, d.action_index, d.signing_pubkey_id, block));
            let unstakeRows = await db.doQuery(
                `SELECT action_index, signing_pubkey_id FROM contract_unstakes
                 WHERE target_contract_index=? AND source_id=? AND tick_id=?
                   AND status_id IN (${unstakePlace})
                   AND signing_pubkey_id<>?
                 ORDER BY action_index ASC`,
                [Number(d.target_contract_index), d.source_id, d.tick_id, ...unstakeStatusIds, d.signing_pubkey_id]);
            for(let row of unstakeRows)
                applied.push(await db.rotateContractStakeKey('contract_unstakes', row, d.action_index, d.signing_pubkey_id, block));
        }
        return governedSlots;
    },

    async revertUngoverned(db, governedSlots, valid_id, unstakeStatusIds, block, applied){
        // 2. Revert pass: rows whose slot no longer has a governing delegation but that still
        //    carry a delegated key. The FIRST journal row per (table, row) carries the
        //    pre-rotation (original) key in prev_signing_pubkey_id; (block_index,
        //    delegation_action_index) is the deterministic order (at most one journal row per
        //    row per block, so the tiebreak is defensive).
        for(let spec of [{ table: 'contract_stakes',   extra: 'AND t.deactivation_block IS NULL', args: [valid_id] },
                         { table: 'contract_unstakes', extra: '', args: unstakeStatusIds }]){
            let statusPredicate = (spec.table === 'contract_stakes')
                ? 't.status_id=?'
                : `t.status_id IN (${spec.args.map(() => '?').join(',')})`;
            let revertQuery = `SELECT r.stake_action_index, r.delegation_action_index,
                                      r.prev_signing_pubkey_id AS original_pubkey_id,
                                      t.signing_pubkey_id      AS current_pubkey_id,
                                      t.target_contract_index, t.source_id, t.tick_id
                               FROM contract_delegation_rotations r
                                   JOIN ${spec.table} t ON (t.action_index = r.stake_action_index)
                               WHERE r.target_table=? AND ${statusPredicate} ${spec.extra}
                                 AND t.signing_pubkey_id <> r.prev_signing_pubkey_id
                                 AND NOT EXISTS (
                                     SELECT 1 FROM contract_delegation_rotations e
                                     WHERE e.stake_action_index = r.stake_action_index
                                       AND e.target_table       = r.target_table
                                       AND (e.block_index < r.block_index
                                            OR (e.block_index = r.block_index
                                                AND e.delegation_action_index < r.delegation_action_index)))
                               ORDER BY t.action_index ASC`;
            let rotated = await db.doQuery(revertQuery, [spec.table, ...spec.args]);
            for(let row of rotated){
                let slot = String(row.target_contract_index) + '|' + String(row.source_id) + '|' + String(row.tick_id);
                if(governedSlots.has(slot)) continue;
                if(String(row.current_pubkey_id) === String(row.original_pubkey_id)) continue;
                if(await db.contractPubkeyClaimedElsewhere(row.original_pubkey_id, row, valid_id)) continue;
                applied.push(await db.rotateContractStakeKey(spec.table,
                    { action_index: row.stake_action_index, signing_pubkey_id: row.current_pubkey_id },
                    row.delegation_action_index, row.original_pubkey_id, block));
            }
        }
    },

};
