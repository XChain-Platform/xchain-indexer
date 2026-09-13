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
 * XChain Indexer - Database mixin: contracts
 * 
 * The queries over the contracts table family in src/sql/. Installed onto Database.prototype by
 * db/index.js, so call sites stay this.db.<method>().
 *
 ********************************************************************/

// Load required libraries
const mariadb = require('mariadb');
const path    = require('path');
const stateKeyCollation = require('../state_key_collation_activation');
const slashGrid = require('../slash_grid_activation');

module.exports = {

    /*
     * Contract-targeted staking methods (STAKE v3 / UNSTAKE v1 / DELEGATE v1)
     * Parallel to the capability staking system; tracked in separate tables to keep
     * capability-staking queries unchanged.
     */

    // Create/Update record in `contract_stakes` table.
    // Each STAKE v3 action gets its own row; active stake for (target, pubkey, tick)
    // is SUM(amount) across all valid rows. Top-up vs. new is determined by caller.
    async createContractStake(data){
        data                    = this.normalizeDataValues(data);
        let status_id           = await this.createStatus(data['STATUS']);
        let source_id           = await this.getAddressId(data['SOURCE']);
        let signing_pubkey_id   = await this.getOrCreatePubkeyId(data['SIGNING_PUBKEY']);
        let tick_id             = await this.createTicker(data['TICK']);
        let action_index        = data['ACTION_INDEX'];
        let version             = data['VERSION'] || 3;
        let target_contract_index = Number(data['TARGET_CONTRACT_INDEX']);
        let amount              = data['AMOUNT'] || '0';
        let block_index         = data['BLOCK_INDEX'];
        let activation_block    = data['ACTIVATION_BLOCK'] || 0;
        let query  = "SELECT action_index FROM contract_stakes WHERE action_index=? LIMIT 1";
        let args   = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            query = `UPDATE contract_stakes SET
                        source_id=?, version=?, signing_pubkey_id=?, target_contract_index=?, tick_id=?,
                        amount=?, status_id=?, block_index=?, activation_block=?
                    WHERE action_index=?`;
            args = [source_id, version, signing_pubkey_id, target_contract_index, tick_id,
                    amount, status_id, block_index, activation_block, action_index];
        } else {
            query = `INSERT INTO contract_stakes
                        (source_id, version, signing_pubkey_id, target_contract_index, tick_id,
                         amount, status_id, block_index, activation_block, action_index)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
            args = [source_id, version, signing_pubkey_id, target_contract_index, tick_id,
                    amount, status_id, block_index, activation_block, action_index];
        }
        await this.doQuery(query, args);
    },

    // Set deactivation_block for the ALREADY-ACTIVE contract_stakes rows matching (target, pubkey, tick).
    // Used by createContractUnstake to start the cooldown on a staker's active (target, tick) rows.
    // Same load-bearing `currentBlock` filter as setStakeDeactivationByPubkey: a pending-activation
    // top-up (activation_block > currentBlock) is excluded from the unstake amount, so deactivating it
    // here would orphan its tokens (cooldown sweep never refunds it). It stays active until a later UNSTAKE.
    async setContractStakeDeactivationByPubkey(targetContractIndex, pubkey, tick, deactivationBlock, currentBlock){
        let pubkey_id = await this.getPubkeyId(String(pubkey).toLowerCase());
        if(pubkey_id === null) return false;
        let tick_id = await this.getTickerId(tick);
        if(tick_id === null) return false;
        let valid_id = await this.getStatusId('valid');
        let query = `UPDATE contract_stakes SET deactivation_block=?
                     WHERE target_contract_index=? AND signing_pubkey_id=? AND tick_id=?
                       AND status_id=? AND deactivation_block IS NULL
                       AND activation_block <= ?`;
        await this.doQuery(query, [deactivationBlock, Number(targetContractIndex), pubkey_id, tick_id, valid_id, currentBlock]);
        return true;
    },

    // Get aggregate active contract-stake for (target, pubkey, tick).
    // Returns { source_id, signing_pubkey_id, signing_pubkey, tick_id, tick, amount, activation_block } or null.
    //
    // SIGNING-KEY ROTATIONS (#4366). `pubkey` is the CURRENT key on the stake row, so once a
    // DELEGATE v1 rotation has been materialized (CONTRACT_DELEGATION_MATERIALIZE) an UNSTAKE
    // names the rotated key, not the original - the same key getContractStakeDataForVM shows the
    // contract. The caller (UNSTAKE v1) still checks that SOURCE owns the aggregate, so a
    // rotation never lets the delegate's holder move someone else's stake.
    async getActiveContractStakeByPubkey(targetContractIndex, pubkey, tick, blockIndex, opts){
        let pubkey_id = await this.getPubkeyId(String(pubkey).toLowerCase());
        if(pubkey_id === null) return null;
        let tick_id = await this.getTickerId(tick);
        if(tick_id === null) return null;
        let valid_id = await this.getStatusId('valid');
        // Select the raw per-row amount strings instead of a SQL SUM. Contract-staked tokens may
        // carry up to MAX_TOKEN_DECIMALS (18) decimals, but SUM(CAST(... AS DECIMAL(30,8))) truncates
        // anything finer than 8 dp before it reaches the refund, and the mariadb driver could further
        // coerce a wide DECIMAL aggregate to a lossy JS Number. Aggregating the raw VARCHAR amounts
        // with the bignumber wrapper at the staked tick's own precision keeps XCHAIN(8) output
        // byte-identical to the old path and makes >8-dp tokens exact (item 5303).
        let query = `SELECT
                        cs.source_id          AS source_id,
                        cs.amount             AS amount,
                        cs.activation_block   AS activation_block,
                        cs.block_index        AS block_index,
                        ip.pubkey             AS signing_pubkey,
                        t.tick                AS tick
                     FROM contract_stakes cs
                         LEFT JOIN index_pubkeys ip ON (ip.id = cs.signing_pubkey_id)
                         LEFT JOIN index_tickers t  ON (t.id  = cs.tick_id)
                     WHERE cs.target_contract_index=? AND cs.signing_pubkey_id=? AND cs.tick_id=? AND cs.status_id=?`;
        let args = [Number(targetContractIndex), pubkey_id, tick_id, valid_id];
        if(blockIndex !== undefined && blockIndex !== null){
            if(opts && opts.undeactivatedOnly){
                // UNSTAKE path: only contract-stakes not already being unstaked
                // (deactivation_block IS NULL). A stake already deactivating from a prior
                // UNSTAKE in the same activation-delay window keeps a future deactivation_block
                // and would otherwise be re-unstaked here, double-crediting the cooldown refund.
                // Mirrors the v0 stakes path (getActiveStakeByPubkey, item 4617).
                query += ' AND cs.activation_block <= ? AND cs.deactivation_block IS NULL';
                args.push(blockIndex);
            } else {
                query += ' AND cs.activation_block <= ? AND (cs.deactivation_block IS NULL OR cs.deactivation_block > ?)';
                args.push(blockIndex);
                args.push(blockIndex);
            }
        }
        query += ' ORDER BY cs.action_index ASC';
        let results = await this.doQuery(query, args);
        if(results.length === 0) return null;
        // Sum the raw amounts at the token's own decimal precision. MIN(source_id/activation_block/
        // block_index) is replicated in JS so the returned shape matches the prior GROUP BY row.
        let decimals = await this.getTokenDecimalPrecision(tick_id);
        let amount = '0';
        let source_id = null, activation_block = null, block_index = null;
        for(let row of results){
            amount = this.util.bcadd(amount, row.amount, decimals);
            let rSource = (row.source_id === null || row.source_id === undefined) ? null : Number(row.source_id);
            if(rSource !== null && (source_id === null || rSource < source_id)) source_id = rSource;
            let rAct = (row.activation_block === null || row.activation_block === undefined) ? null : Number(row.activation_block);
            if(rAct !== null && (activation_block === null || rAct < activation_block)) activation_block = rAct;
            let rBlk = (row.block_index === null || row.block_index === undefined) ? null : Number(row.block_index);
            if(rBlk !== null && (block_index === null || rBlk < block_index)) block_index = rBlk;
        }
        // bcadd returns a bignumber; emit the canonical fixed-precision string the callers expect
        // (matches the prior String(SUM(...)) representation for XCHAIN at 8 dp).
        amount = this.util.bcformat(amount, decimals);
        return {
            source_id:         source_id,
            signing_pubkey_id: pubkey_id,
            signing_pubkey:    results[0].signing_pubkey,
            tick_id:           tick_id,
            tick:              results[0].tick,
            amount:            amount,
            activation_block:  activation_block,
            block_index:       block_index
        };
    },

    // Check whether the (target, source) combination already owns an active stake for (pubkey, tick).
    // Used by STAKE v3 to detect "new vs. top-up" - top-up requires the existing stake be owned by the same source.
    async getContractStakeOwner(targetContractIndex, pubkey, tick){
        let pubkey_id = await this.getPubkeyId(String(pubkey).toLowerCase());
        if(pubkey_id === null) return null;
        let tick_id = await this.getTickerId(tick);
        if(tick_id === null) return null;
        let valid_id = await this.getStatusId('valid');
        let query = `SELECT source_id FROM contract_stakes
                     WHERE target_contract_index=? AND signing_pubkey_id=? AND tick_id=? AND status_id=?
                     ORDER BY action_index ASC LIMIT 1`;
        let results = await this.doQuery(query, [Number(targetContractIndex), pubkey_id, tick_id, valid_id]);
        if(results.length === 0) return null;
        return Number(results[0].source_id);
    },

    // Create/Update record in `contract_unstakes` table
    async createContractUnstake(data){
        data                  = this.normalizeDataValues(data);
        let status_id         = await this.createStatus(data['STATUS']);
        let source_id         = await this.getAddressId(data['SOURCE']);
        let signing_pubkey_id = await this.getOrCreatePubkeyId(data['SIGNING_PUBKEY']);
        let tick_id           = await this.createTicker(data['TICK']);
        let target_contract_index = Number(data['TARGET_CONTRACT_INDEX']);
        let action_index      = data['ACTION_INDEX'];
        let cooldown_end_block = data['COOLDOWN_END_BLOCK'];
        let amount            = data['AMOUNT'] || '0';
        let block_index       = data['BLOCK_INDEX'];
        let query  = "SELECT action_index FROM contract_unstakes WHERE action_index=? LIMIT 1";
        let args   = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            query = `UPDATE contract_unstakes SET
                        source_id=?, signing_pubkey_id=?, target_contract_index=?, tick_id=?,
                        cooldown_end_block=?, amount=?, status_id=?, block_index=?
                    WHERE action_index=?`;
            args = [source_id, signing_pubkey_id, target_contract_index, tick_id,
                    cooldown_end_block, amount, status_id, block_index, action_index];
        } else {
            query = `INSERT INTO contract_unstakes
                        (source_id, signing_pubkey_id, target_contract_index, tick_id,
                         cooldown_end_block, amount, status_id, block_index, action_index)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
            args = [source_id, signing_pubkey_id, target_contract_index, tick_id,
                    cooldown_end_block, amount, status_id, block_index, action_index];
        }
        await this.doQuery(query, args);
    },

    // Create/Update record in `contract_delegations` table
    async createContractDelegation(data){
        data                  = this.normalizeDataValues(data);
        let status_id         = await this.createStatus(data['STATUS']);
        let source_id         = await this.getAddressId(data['SOURCE']);
        let signing_pubkey_id = await this.getOrCreatePubkeyId(data['SIGNING_PUBKEY']);
        let tick_id           = await this.createTicker(data['TICK']);
        let target_contract_index = Number(data['TARGET_CONTRACT_INDEX']);
        let action_index      = data['ACTION_INDEX'];
        let block_index       = data['BLOCK_INDEX'];
        let activation_block  = data['ACTIVATION_BLOCK'] || 0;
        let query  = "SELECT action_index FROM contract_delegations WHERE action_index=? LIMIT 1";
        let args   = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            query = `UPDATE contract_delegations SET
                        source_id=?, signing_pubkey_id=?, target_contract_index=?, tick_id=?,
                        status_id=?, block_index=?, activation_block=?
                    WHERE action_index=?`;
            args = [source_id, signing_pubkey_id, target_contract_index, tick_id,
                    status_id, block_index, activation_block, action_index];
        } else {
            query = `INSERT INTO contract_delegations
                        (source_id, signing_pubkey_id, target_contract_index, tick_id,
                         status_id, block_index, activation_block, action_index)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
            args = [source_id, signing_pubkey_id, target_contract_index, tick_id,
                    status_id, block_index, activation_block, action_index];
        }
        await this.doQuery(query, args);
    },

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
        let unstakePlace     = unstakeStatusIds.map(() => '?').join(',');

        // Slots under an active delegation; the revert pass below must leave these alone.
        let governedSlots = new Set();
        for(let d of governing){
            governedSlots.add(String(d.target_contract_index) + '|' + String(d.source_id) + '|' + String(d.tick_id));
            // Rows that already carry the delegated key are skipped, so a materialized rotation
            // is a no-op on every later block (and writes no further journal rows).
            let stakeRows = await this.doQuery(
                `SELECT action_index, signing_pubkey_id FROM contract_stakes
                 WHERE target_contract_index=? AND source_id=? AND tick_id=? AND status_id=?
                   AND deactivation_block IS NULL
                   AND signing_pubkey_id<>?
                 ORDER BY action_index ASC`,
                [Number(d.target_contract_index), d.source_id, d.tick_id, valid_id, d.signing_pubkey_id]);
            for(let row of stakeRows)
                applied.push(await this.rotateContractStakeKey('contract_stakes', row, d.action_index, d.signing_pubkey_id, block));
            let unstakeRows = await this.doQuery(
                `SELECT action_index, signing_pubkey_id FROM contract_unstakes
                 WHERE target_contract_index=? AND source_id=? AND tick_id=?
                   AND status_id IN (${unstakePlace})
                   AND signing_pubkey_id<>?
                 ORDER BY action_index ASC`,
                [Number(d.target_contract_index), d.source_id, d.tick_id, ...unstakeStatusIds, d.signing_pubkey_id]);
            for(let row of unstakeRows)
                applied.push(await this.rotateContractStakeKey('contract_unstakes', row, d.action_index, d.signing_pubkey_id, block));
        }

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
            let rotated = await this.doQuery(revertQuery, [spec.table, ...spec.args]);
            for(let row of rotated){
                let slot = String(row.target_contract_index) + '|' + String(row.source_id) + '|' + String(row.tick_id);
                if(governedSlots.has(slot)) continue;
                if(String(row.current_pubkey_id) === String(row.original_pubkey_id)) continue;
                if(await this._contractPubkeyClaimedElsewhere(row.original_pubkey_id, row, valid_id)) continue;
                applied.push(await this.rotateContractStakeKey(spec.table,
                    { action_index: row.stake_action_index, signing_pubkey_id: row.current_pubkey_id },
                    row.delegation_action_index, row.original_pubkey_id, block));
            }
        }
        return applied;
    },

    // True when `pubkeyId` is held by a contract stake outside this (target, source, tick) slot,
    // or by any active contract delegation. Guards the revert pass: handing a slot back its
    // original key while someone else holds that key would merge two owners into one staker
    // entry in the VM snapshot.
    async _contractPubkeyClaimedElsewhere(pubkeyId, slotRow, validStatusId){
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

    // Snapshot the contract's stake state at blockIndex into an in-memory accessor
    // returned to the VM execution context. Methods on the returned object are
    // synchronous since they query the pre-loaded snapshot only.
    //
    // The snapshot is scoped to THIS contract (targetContractIndex) - a contract
    // calling xchain.contract.* cannot see other contracts' stakes through this
    // accessor (implicit slash authorization). The 1000-staker cap on getStakers
    // is applied here at query time (LIMIT clause).
    //
    // SIGNING-KEY ROTATIONS (#4366). This reads contract_stakes.signing_pubkey_id and nothing
    // else - deliberately, and it must stay that way. A DELEGATE v1 rotation reaches the
    // snapshot because materializeContractDelegations rewrites the stake row itself at the
    // delegation's activation block (CONTRACT_DELEGATION_MATERIALIZE), so the pubkey a contract
    // sees in getStakers is by construction the same one slashContractStake can debit. Joining
    // contract_delegations in HERE instead would hand the contract a key the SLASH path cannot
    // find, and the emitted punishment would silently no-op at execute.js's zero-slashed guard.
    async getContractStakeDataForVM(targetContractIndex, blockIndex){
        let valid_id = await this.getStatusId('valid');
        let stakes = [];
        if(valid_id !== null){
            let query = `SELECT cs.signing_pubkey_id, ip.pubkey AS pubkey, cs.tick_id, t.tick AS tick, cs.amount,
                                cs.activation_block, cs.deactivation_block
                         FROM contract_stakes cs
                             LEFT JOIN index_pubkeys ip ON (ip.id = cs.signing_pubkey_id)
                             LEFT JOIN index_tickers t  ON (t.id  = cs.tick_id)
                         WHERE cs.target_contract_index=? AND cs.status_id=?
                           AND cs.activation_block <= ?
                           AND (cs.deactivation_block IS NULL OR cs.deactivation_block > ?)`;
            stakes = await this.doQuery(query, [Number(targetContractIndex), valid_id, blockIndex, blockIndex]);
        }
        // Aggregate (pubkey, tick) → amount; also build per-tick stakers map for getStakers/getTotalStaked.
        let perPubkeyTick = new Map();      // key: pubkey + '|' + tick → string amount
        let perTickStakers = new Map();     // key: tick → Map(pubkey → string amount)
        let util = this.util;
        // Contract stakes accept any tick up to MAX_TOKEN_DECIMALS (18), so aggregate each at its
        // own token precision. A flat 8-dp bcadd truncates the amounts the VM observes through
        // getStake/getTotalStaked/getStakers for >8-dp tokens (and would then drive a wrong slash);
        // XCHAIN(8) is unaffected. Per-tick decimals are precomputed here because the aggregation
        // below is synchronous (item 5303).
        let tickDecimals = new Map();       // tick string → decimals
        for(let row of stakes){
            let tk = String(row.tick || '');
            if(tk && !tickDecimals.has(tk))
                tickDecimals.set(tk, await this.getTokenDecimalPrecision(row.tick_id));
        }
        for(let row of stakes){
            let pubkey = String(row.pubkey || '').toLowerCase();
            let tick   = String(row.tick || '');
            if(!pubkey || !tick) continue;
            let dec = tickDecimals.has(tick) ? tickDecimals.get(tick) : 8;
            let key = pubkey + '|' + tick;
            perPubkeyTick.set(key, util.bcadd((perPubkeyTick.get(key) || '0'), row.amount, dec));
            if(!perTickStakers.has(tick)) perTickStakers.set(tick, new Map());
            let m = perTickStakers.get(tick);
            m.set(pubkey, util.bcadd((m.get(pubkey) || '0'), row.amount, dec));
        }
        // Return a SERIALIZABLE snapshot (plain data), not closures: the VM runs
        // in a forked worker and the read-only data must cross the IPC boundary.
        // xchain-vm/src/readonly-accessors.js rebuilds the sync getStake/
        // getTotalStaked/getStakers accessors from this shape inside the worker.
        let stakeByPubkeyTick = {};
        for(let [key, amt] of perPubkeyTick.entries()) stakeByPubkeyTick[key] = amt;

        let totalByTick   = {};
        let stakersByTick = {};
        for(let [tick, stakers] of perTickStakers.entries()){
            let dec = tickDecimals.has(tick) ? tickDecimals.get(tick) : 8;
            let total = '0';
            let arr = [];
            for(let [pk, amt] of stakers.entries()){
                total = util.bcadd(total, amt, dec);
                arr.push({ pubkey: pk, amount: amt });
            }
            // Sort stakers biggest to smallest. Equal amounts fall back to a lexicographic
            // pubkey tiebreak so the order is deterministic across nodes - the source query
            // carries no ORDER BY, so without this, equal-amount stakers would order in
            // engine-arbitrary row order. That matters twice: it sets the iteration order a
            // contract's getStakers() observes, AND it decides which stakers survive the
            // 1000-cap slice below when ties straddle the boundary - either of which would
            // fork getStakers() membership (and any contract branching on it) across
            // validators. pubkey is unique per tick here (aggregated), so this is a total order.
            arr.sort((a, b) => {
                if(util.bcgt(b.amount, a.amount)) return  1;
                if(util.bcgt(a.amount, b.amount)) return -1;
                return a.pubkey < b.pubkey ? -1 : a.pubkey > b.pubkey ? 1 : 0;
            });
            totalByTick[tick]   = total;
            stakersByTick[tick] = arr.slice(0, 1000);
        }
        return { stakeByPubkeyTick, totalByTick, stakersByTick };
    },

    // Slash a staker. Deducts `amount` from active contract_stakes rows first (LIFO by
    // activation_block / action_index), then from contract_unstakes rows if any remainder.
    // Does NOT credit the destination or emit the slash_events row - caller (_processSlashEmission)
    // wires those side effects.
    //
    // Returns { total, releases }:
    //   total    - the amount actually slashed, as a string (less than `amount` when the
    //              available stake is lower).
    //   releases - [{ address, amount }] per OWNING address, in LIFO row order, summing to
    //              `total`. Staked tokens sit in the staker's ESCROW, so the caller releases
    //              them there before crediting the destination. Per-owner because one slash
    //              reduces several rows and a delegated key's rows can span sources.
    //
    // SIGNING-KEY ROTATIONS (#4366). `pubkeyId` is resolved from the pubkey the contract emitted,
    // which it read out of the same snapshot getContractStakeDataForVM built, and that snapshot
    // reads the stake row's CURRENT key. Because materializeContractDelegations rewrites the row
    // at the delegation's activation block, a SLASH against a rotated staker lands on the very
    // rows the contract was shown, instead of matching nothing and returning '0' (which
    // _processSlashEmission's zero-slashed path then records as a punishment the ledger never
    // applied). No rotation-aware lookup belongs here: the row IS the rotation.
    async slashContractStake(targetContractIndex, pubkeyId, tickId, amount, blockIndex, executionIndex, slashPosition){
        let valid_id = await this.getStatusId('valid');
        if(valid_id === null) return { total: '0', releases: [] };
        let remaining = String(amount);
        let totalSlashed = '0';
        // The staked tick may carry up to MAX_TOKEN_DECIMALS (18); do all slash arithmetic at its own
        // precision so an >8-dp token isn't truncated mid-deduction (which would leave dust unslashed
        // or corrupt the residual stake). XCHAIN(8) math is unchanged (item 5303).
        let dec = await this.getTokenDecimalPrecision(tickId);
        // Conserve value across the deduction (flag-day, slash_grid_activation.js). Rounding
        // the row write and the credit SEPARATELY at `dec` lets them disagree: HALF-UP at
        // decimals=0 turns a '0.5' slash of a '1' row into an unchanged row and a full-unit
        // credit. Floor the request onto the tick's grid ONCE (a punishment may not grow on
        // the way in), then run the per-row deduction at exact precision so every derived
        // figure below is the reduction the row actually took.
        let gridOn = slashGrid.isSlashGridActive(blockIndex, this.config['NETWORK'], this.config['COIN']);
        let deductDec = gridOn ? slashGrid.SLASH_DEDUCTION_PRECISION : dec;
        if(gridOn){
            remaining = this.util.bcstr(this.util.bcmulfloor(remaining, '1', dec));
            // An off-grid request that floors away is a no-op, not a free credit; the caller's
            // zero-slashed branch already logs it as an attempted punishment that took nothing.
            if(!this.util.bcgt(remaining, '0')) return { total: '0', releases: [] };
        }
        // Escrow release breakdown, accumulated as the rows are debited. Insertion order is
        // the deterministic LIFO scan order, so every node writes its escrow rows alike.
        let releases = new Map();
        let addRelease = (address, take) => {
            // An unresolvable source cannot have its escrow released against anyone, and
            // guessing would strand the lock. Halt instead.
            if(address === null || address === undefined)
                throw new Error('slashContractStake: stake row has no source address; its escrow is not releasable');
            let cur = releases.get(address);
            releases.set(address, this.util.bcstr(this.util.bcadd(cur === undefined ? '0' : cur, take, deductDec)));
        };
        let asReleases = () => Array.from(releases, ([address, amt]) => ({ address, amount: amt }));
        // Pass 1: deduct from ACTIVE (never-unstaked) contract_stakes rows (LIFO - highest
        // action_index first). The deactivation filter is load-bearing: UNSTAKE v1 leaves the
        // contract_stakes row's `amount` intact (it only sets a FUTURE deactivation_block =
        // block + ACTIVATION_DELAY_BLOCKS) AND mirrors the tokens into a contract_unstakes
        // cooldown row that the block-end sweep refunds in full. So the tokens exist in exactly
        // one slashable place per lifecycle stage: contract_stakes while deactivation_block IS
        // NULL, contract_unstakes once UNSTAKE has run. Pass 1 must therefore skip EVERY row that
        // carries a deactivation_block (Pass 2 slashes those from contract_unstakes). Filtering on
        // `deactivation_block > blockIndex` was wrong: because the block is in the future, that
        // predicate is TRUE throughout the [unstake, unstake+delay) window, so a slash landing in
        // the window slashed the phantom contract_stakes copy (crediting the destination) while the
        // sweep still refunded the contract_unstakes row - +X to the destination AND +X back to the
        // staker against one debit (silent supply inflation + total slash evasion).
        let stakesQ = `SELECT cs.action_index, cs.amount, a.address AS source_address
                       FROM contract_stakes cs
                           LEFT JOIN index_addresses a ON (a.id = cs.source_id)
                       WHERE cs.target_contract_index=? AND cs.signing_pubkey_id=? AND cs.tick_id=? AND cs.status_id=?
                         AND CAST(cs.amount AS DECIMAL(60,18)) > 0
                         AND cs.deactivation_block IS NULL
                       ORDER BY cs.action_index DESC`;
        let stakeRows = await this.doQuery(stakesQ, [Number(targetContractIndex), pubkeyId, tickId, valid_id]);
        for(let row of stakeRows){
            if(!this.util.bcgt(remaining, '0')) break;
            let rowAmt = String(row.amount);
            let take = this.util.bcgte(rowAmt, remaining) ? remaining : rowAmt;
            let newAmt = this.util.bcsub(rowAmt, take, deductDec);
            // Re-derive the take from what was WRITTEN, not from what was asked for. Deriving it
            // at `dec` instead would round an off-grid stored row's delta back up and credit a
            // unit the row never held; at exact precision the identity is unconditional.
            if(gridOn) take = this.util.bcstr(this.util.bcsub(rowAmt, newAmt, deductDec));
            await this.doQuery('UPDATE contract_stakes SET amount=? WHERE action_index=?', [newAmt, row.action_index]);
            // Record the in-place debit so a reorg can restore rowAmt verbatim (see rollback.js).
            await this.createContractSlashDebit(executionIndex, slashPosition, 'contract_stakes', row.action_index, rowAmt, take, blockIndex);
            addRelease(row.source_address, take);
            remaining = this.util.bcsub(remaining, take, deductDec);
            totalSlashed = this.util.bcadd(totalSlashed, take, deductDec);
        }
        if(!this.util.bcgt(remaining, '0')) return { total: this.util.bcstr(totalSlashed), releases: asReleases() };
        // Pass 2: deduct from contract_unstakes rows (cooldown-locked but still slashable)
        let pendingId = await this.getStatusId('pending');
        let unstakeStatusIds = [valid_id];
        if(pendingId !== null) unstakeStatusIds.push(pendingId);
        let placeholders = unstakeStatusIds.map(() => '?').join(',');
        let unstakesQ = `SELECT cu.action_index, cu.amount, a.address AS source_address
                         FROM contract_unstakes cu
                             LEFT JOIN index_addresses a ON (a.id = cu.source_id)
                         WHERE cu.target_contract_index=? AND cu.signing_pubkey_id=? AND cu.tick_id=?
                           AND cu.status_id IN (${placeholders})
                           AND CAST(cu.amount AS DECIMAL(60,18)) > 0
                         ORDER BY cu.action_index DESC`;
        let unstakeRows = await this.doQuery(unstakesQ, [Number(targetContractIndex), pubkeyId, tickId, ...unstakeStatusIds]);
        for(let row of unstakeRows){
            if(!this.util.bcgt(remaining, '0')) break;
            let rowAmt = String(row.amount);
            let take = this.util.bcgte(rowAmt, remaining) ? remaining : rowAmt;
            let newAmt = this.util.bcsub(rowAmt, take, deductDec);
            // Same re-derivation as Pass 1: the cooldown rows are debited by the identical
            // arithmetic, so they carry the identical conservation hole without it.
            if(gridOn) take = this.util.bcstr(this.util.bcsub(rowAmt, newAmt, deductDec));
            await this.doQuery('UPDATE contract_unstakes SET amount=? WHERE action_index=?', [newAmt, row.action_index]);
            // Record the in-place debit so a reorg can restore rowAmt verbatim (see rollback.js).
            await this.createContractSlashDebit(executionIndex, slashPosition, 'contract_unstakes', row.action_index, rowAmt, take, blockIndex);
            addRelease(row.source_address, take);
            remaining = this.util.bcsub(remaining, take, deductDec);
            totalSlashed = this.util.bcadd(totalSlashed, take, deductDec);
        }
        return { total: this.util.bcstr(totalSlashed), releases: asReleases() };
    },

    // Record one in-place slash debit, enabling reorg restoration of stake amounts.
    // slashContractStake reduces contract_stakes/contract_unstakes.amount IN PLACE on
    // rows created in earlier (surviving) blocks; the generic rollback delete cannot
    // revert that. This row captures `prev_amount` - the row's EXACT amount string
    // before the debit - so rollback.js can copy it back verbatim (string copy, no
    // arithmetic → byte-identical on source + replica, and identical to a from-genesis
    // replay where the slash was never re-mined). `amount` is the per-row delta (audit).
    async createContractSlashDebit(executionIndex, slashPosition, targetTable, stakeActionIndex, prevAmount, amount, blockIndex){
        let query = `INSERT INTO contract_slash_debits
                        (execution_index, slash_position, target_table, stake_action_index,
                         prev_amount, amount, block_index)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`;
        await this.doQuery(query, [executionIndex, slashPosition, targetTable, stakeActionIndex,
                                   String(prevAmount), this.util.bcstr(amount), blockIndex]);
    },

    // Process cooldown completions at the end of a block.
    // Sweeps BOTH capability `unstakes` AND `contract_unstakes` tables: any row where
    // cooldown_end_block <= currentBlock and status='pending' (or 'valid') gets its
    // remaining amount credited back to the source, and the row is marked 'completed'.
    // Returns array of credit tuples [tick, amount, address] for processTransactionLedgerChanges,
    // plus the rowids that were finalized so they can be updated to 'completed' status.
    async sweepCompletedCooldowns(currentBlock){
        let credits = [];
        let pendingId = await this.getStatusId('pending');
        let validId = await this.getStatusId('valid');
        let completedId = await this.createStatus('completed');
        // Status filter - most existing unstakes carry 'valid' since createStatus normalizes that way.
        let statusIds = [];
        if(pendingId !== null) statusIds.push(pendingId);
        if(validId !== null) statusIds.push(validId);
        if(statusIds.length === 0) return { credits, capabilityRows: [], contractRows: [] };
        let placeholders = statusIds.map(() => '?').join(',');
        let gas = this.config['GAS'];
        // Capability unstakes (XCHAIN only)
        let capQ = `SELECT u.action_index, u.amount, a.address AS source_address
                    FROM unstakes u
                        LEFT JOIN index_addresses a ON (a.id = u.source_id)
                    WHERE u.cooldown_end_block <= ?
                      AND u.status_id IN (${placeholders})
                      AND CAST(u.amount AS DECIMAL(30,8)) > 0
                    ORDER BY u.action_index ASC`;
        let capRows = await this.doQuery(capQ, [currentBlock, ...statusIds]);
        let capabilityRows = [];
        for(let row of capRows){
            credits.push([gas, String(row.amount), row.source_address]);
            capabilityRows.push(row.action_index);
        }
        // Contract unstakes (any tick)
        // Positivity filter is cast at DECIMAL(60,18) (not 30,8) so a contract refund finer than
        // 8 dp on an >8-dp token isn't truncated to 0 and stranded as a never-swept 'pending' row.
        // XCHAIN(8) and every <=8-dp refund evaluate identically under either scale (item 5303).
        let conQ = `SELECT cu.action_index, cu.amount, a.address AS source_address, t.tick AS tick
                    FROM contract_unstakes cu
                        LEFT JOIN index_addresses a ON (a.id = cu.source_id)
                        LEFT JOIN index_tickers   t ON (t.id = cu.tick_id)
                    WHERE cu.cooldown_end_block <= ?
                      AND cu.status_id IN (${placeholders})
                      AND CAST(cu.amount AS DECIMAL(60,18)) > 0
                    ORDER BY cu.action_index ASC`;
        let conRows = await this.doQuery(conQ, [currentBlock, ...statusIds]);
        let contractRows = [];
        for(let row of conRows){
            credits.push([row.tick, String(row.amount), row.source_address]);
            contractRows.push(row.action_index);
        }
        return { credits, capabilityRows, contractRows, completedId };
    },

    // Mark unstake / contract_unstake rows as completed after their funds have been credited.
    async markCooldownsCompleted(capabilityRowIds, contractRowIds, completedStatusId){
        if(capabilityRowIds && capabilityRowIds.length > 0){
            let placeholders = capabilityRowIds.map(() => '?').join(',');
            await this.doQuery(
                `UPDATE unstakes SET status_id=? WHERE action_index IN (${placeholders})`,
                [completedStatusId, ...capabilityRowIds]
            );
        }
        if(contractRowIds && contractRowIds.length > 0){
            let placeholders = contractRowIds.map(() => '?').join(',');
            await this.doQuery(
                `UPDATE contract_unstakes SET status_id=? WHERE action_index IN (${placeholders})`,
                [completedStatusId, ...contractRowIds]
            );
        }
    },

    /*
     * VM action methods
     */

    // Create/Update record in `contracts` table
    async createContract(data){
        data             = this.normalizeDataValues(data);
        let status_id    = await this.createStatus(data['STATUS']);
        let source_id    = await this.getAddressId(data['SOURCE']);
        let action_index = data['ACTION_INDEX'];
        let code         = data['CODE'];
        let code_hash    = data['CODE_HASH'];
        let api_version  = data['API_VERSION'] || 1;
        let block_index  = data['BLOCK_INDEX'];
        // DEPLOY v1+ staking config (NULL when contract is not opted into contract-staking)
        let cooldown_blocks = (this.util.isNull(data['COOLDOWN_BLOCKS'])) ? null : Number(data['COOLDOWN_BLOCKS']);
        let slash_destination_id = null;
        if(!this.util.isNull(data['SLASH_DESTINATION'])){
            slash_destination_id = await this.createAddress(data['SLASH_DESTINATION']);
        }
        // Contract meta manifest (CONTRACT_META_REQUIRED). deploy.js hands these over only
        // for a valid deploy whose exported meta conforms to the byte grammar, so an absent
        // key is a NULL column and an oversized value never reaches VARCHAR(64) at all - the
        // write site, not the column width, is what keeps errno 1406 out of the indexer.
        let meta_name        = (this.util.isNull(data['META_NAME']))        ? null : data['META_NAME'];
        let meta_description = (this.util.isNull(data['META_DESCRIPTION'])) ? null : data['META_DESCRIPTION'];
        let meta_version     = (this.util.isNull(data['META_VERSION']))     ? null : data['META_VERSION'];
        let meta_json        = (this.util.isNull(data['META_JSON']))        ? null : data['META_JSON'];
        let query  = "SELECT action_index FROM contracts WHERE action_index=? LIMIT 1";
        let args   = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            query = `UPDATE contracts SET
                        source_id=?, code=?, code_hash=?, api_version=?, status_id=?, block_index=?,
                        cooldown_blocks=?, slash_destination_id=?,
                        meta_name=?, meta_description=?, meta_version=?, meta_json=?
                    WHERE action_index=?`;
            args = [source_id, code, code_hash, api_version, status_id, block_index,
                    cooldown_blocks, slash_destination_id,
                    meta_name, meta_description, meta_version, meta_json, action_index];
        } else {
            query = `INSERT INTO contracts
                        (source_id, code, code_hash, api_version, status_id, block_index,
                         cooldown_blocks, slash_destination_id,
                         meta_name, meta_description, meta_version, meta_json, action_index)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
            args = [source_id, code, code_hash, api_version, status_id, block_index,
                    cooldown_blocks, slash_destination_id,
                    meta_name, meta_description, meta_version, meta_json, action_index];
        }
        await this.doQuery(query, args);
    },

    // Get contract by action_index
    async getContract(action_index){
        let query = `SELECT * FROM contracts WHERE action_index=? LIMIT 1`;
        let results = await this.doQuery(query, [action_index]);
        if(results.length > 0)
            return results[0];
        return null;
    },

    // Find the UNCONSUMED pending assembler of a chunked-DEPLOY group (same deployer,
    // same code_hash) at a LOWER action_index than the action asking (DEPLOY_DEFERRED_
    // ASSEMBLY, R1/R2). A pending assembler is a contracts row whose status is the
    // pending string, written once at the assembler's index and never mutated; it is
    // consumed iff some contract_executions row names it in assembler_action_index (the
    // row the completing action writes unconditionally), so consumption is a NOT EXISTS
    // and rollback of the completing action un-consumes it by construction. Returns the
    // wire parameters the deployment at the completing action needs (gas_limit and
    // input_params from the assembler's execution row, cooldown_blocks and the resolved
    // slash_destination_id from its contracts row, the mode it paid its base fee in) or
    // null when the group has no pending assembler. Lowest action_index wins so every
    // node picks the same one; the duplicate-pending rejection in deploy.js means there
    // is at most one anyway.
    async getPendingDeployAssembler(source, codeHash, beforeActionIndex){
        let source_id = await this.getAddressId(source);
        if(source_id === null) return null;
        let query = `SELECT c.action_index, c.block_index, c.code_hash, c.cooldown_blocks, c.slash_destination_id,
                            ce.gas_limit, ce.input_params, ce.fee_payment_mode
                     FROM contracts c
                     INNER JOIN contract_executions ce ON (ce.action_index=c.action_index)
                     INNER JOIN index_statuses s ON (s.id=c.status_id)
                     WHERE c.source_id=? AND c.code_hash=? AND c.action_index < ?
                       AND s.status='pending: CODE_HASH (awaiting chunks)'
                       AND NOT EXISTS (SELECT 1 FROM contract_executions x WHERE x.assembler_action_index=c.action_index)
                     ORDER BY c.action_index ASC
                     LIMIT 1`;
        let results = await this.doQuery(query, [source_id, codeHash, beforeActionIndex]);
        return results.length > 0 ? results[0] : null;
    },

    // Persist a contract's declared permissions manifest (Phase E). Upsert keyed on
    // the DEPLOY action_index (the rollback key) - mirrors createContract. PERMISSIONS
    // is the validated array of permitted emission action types (stored as JSON) or
    // null when the contract declared none (unrestricted); MAX_TAKE_BPS is the tighter
    // per-contract royalty cap or null (global cap applies). deploy.js validates both
    // before calling this; deleteContract clears the row on a failed deploy.
    async createContractPermission(data){
        // Capture the permissions ARRAY before normalizeDataValues runs: that routine
        // safeToString()s every object-typed field, which coerces an array to a
        // comma-joined string ('SEND,ISSUE') - JSON.stringify would then persist
        // '"SEND,ISSUE"' instead of '["SEND","ISSUE"]', and getContractPermissions'
        // Array.isArray check would read it back as a non-array and SILENTLY disable
        // the emission allowlist. Stringify the raw array here so the JSON is intact.
        let permsRaw       = data['PERMISSIONS'];
        data               = this.normalizeDataValues(data);
        let action_index   = data['ACTION_INDEX'];
        let contract_index = data['CONTRACT_INDEX'];
        let permissions    = this.util.isNull(permsRaw)            ? null : JSON.stringify(permsRaw);
        let max_take_bps   = this.util.isNull(data['MAX_TAKE_BPS']) ? null : Number(data['MAX_TAKE_BPS']);
        let block_index    = data['BLOCK_INDEX'];
        let query  = "SELECT action_index FROM contract_permissions WHERE action_index=? LIMIT 1";
        let args   = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            query = `UPDATE contract_permissions SET
                        contract_index=?, permissions=?, max_take_bps=?, block_index=?
                    WHERE action_index=?`;
            args = [contract_index, permissions, max_take_bps, block_index, action_index];
        } else {
            query = `INSERT INTO contract_permissions
                        (contract_index, permissions, max_take_bps, block_index, action_index)
                    VALUES (?, ?, ?, ?, ?)`;
            args = [contract_index, permissions, max_take_bps, block_index, action_index];
        }
        await this.doQuery(query, args);
    },

    // Read a contract's persisted permissions manifest (Phase E). Returns
    //   { permissions: string[]|null, maxTakeBps: number|null }
    // or null when the contract declared no manifest (no row) - the unrestricted,
    // backward-compatible default the callers (processEmission / runControllerGuard)
    // treat as "no per-contract restriction". permissions is JSON-parsed back to an
    // array; a NULL column stays null (unrestricted).
    async getContractPermissions(contractIndex){
        let query = `SELECT permissions, max_take_bps FROM contract_permissions WHERE contract_index=? LIMIT 1`;
        let results = await this.doQuery(query, [contractIndex]);
        if(results.length === 0)
            return null;
        let row = results[0];
        let permissions = null;
        if(!this.util.isNull(row.permissions)){
            try { permissions = JSON.parse(row.permissions); } catch(e){ permissions = null; }
        }
        let maxTakeBps = this.util.isNull(row.max_take_bps) ? null : Number(row.max_take_bps);
        return { permissions, maxTakeBps };
    },

    // Create record in `contract_executions` table
    async createContractExecution(data){
        data             = this.normalizeDataValues(data);
        let status_id    = await this.createStatus(data['STATUS']);
        let caller_id    = await this.getAddressId(data['CALLER']);
        let action_index = data['ACTION_INDEX'];
        let contract_index = data['CONTRACT_INDEX'];
        let method_name  = data['METHOD_NAME'];
        let input_params = data['INPUT_PARAMS'];
        let gas_used     = data['GAS_USED'];
        let gas_limit    = data['GAS_LIMIT'];
        let error_message = data['ERROR_MESSAGE'];
        let emitted_count = data['EMITTED_COUNT'] || 0;
        let block_index  = data['BLOCK_INDEX'];
        // Deferred chunked-DEPLOY fields (DEPLOY_DEFERRED_ASSEMBLY): the pending
        // assembler this constructor row consumed (NULL for inline and self-completed
        // deploys, and for every non-DEPLOY execution) and the fee mode a DEPLOY
        // constructor row's base fee was paid in (1 native, 2 XCHAIN; NULL before the
        // flag day and for non-DEPLOY rows). Neither enters a block-hash preimage.
        let assembler_action_index = this.util.isNull(data['ASSEMBLER_ACTION_INDEX']) ? null : data['ASSEMBLER_ACTION_INDEX'];
        let fee_payment_mode = this.util.isNull(data['FEE_PAYMENT_MODE']) ? null : data['FEE_PAYMENT_MODE'];
        let query  = "SELECT action_index FROM contract_executions WHERE action_index=? LIMIT 1";
        let args   = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            query = `UPDATE contract_executions SET
                        contract_index=?, caller_id=?, method_name=?, input_params=?,
                        gas_used=?, gas_limit=?, status_id=?, error_message=?,
                        emitted_count=?, block_index=?,
                        assembler_action_index=?, fee_payment_mode=?
                    WHERE action_index=?`;
            args = [contract_index, caller_id, method_name, input_params,
                    gas_used, gas_limit, status_id, error_message,
                    emitted_count, block_index,
                    assembler_action_index, fee_payment_mode, action_index];
        } else {
            query = `INSERT INTO contract_executions
                        (contract_index, caller_id, method_name, input_params,
                         gas_used, gas_limit, status_id, error_message,
                         emitted_count, block_index,
                         assembler_action_index, fee_payment_mode, action_index)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
            args = [contract_index, caller_id, method_name, input_params,
                    gas_used, gas_limit, status_id, error_message,
                    emitted_count, block_index,
                    assembler_action_index, fee_payment_mode, action_index];
        }
        await this.doQuery(query, args);
    },

    /*****************************************************************
     * VM Integration - Contract State
     ****************************************************************/

    // Get the current state of a contract as a { key: value } object.
    // `blockIndex` is the block being processed and drives the state_key
    // collation flag-day (state_key_collation_activation.js): contract_state is
    // utf8_general_ci, so the legacy GROUP BY folds distinct keys like
    // "Key"/"key" into ONE group and the reload drops one of them - the key
    // vanishes on the next EXECUTE despite the null-prototype round-trip
    // contract below. At/after the activation height the reload groups by
    // state_key_bin (the utf8_bin generated shadow of state_key, byte-identical
    // rows to GROUP BY state_key COLLATE utf8_bin but index-backed via
    // idx_latest_bin) so every distinct key survives reload; below it (or when
    // no blockIndex is supplied) the legacy folding form is kept so historical
    // re-execution stays byte-identical.
    async getContractState(contractIndex, blockIndex){
        // Get the latest row per key using MAX(id)
        // The idx_latest index (contract_index, state_key, id DESC) makes this efficient
        let stateKeyBin = (blockIndex !== undefined) && stateKeyCollation.isStateKeyBinCollationActive(
            blockIndex, this.config['NETWORK'], this.config['COIN']);
        let query = `SELECT cs.state_key, cs.state_value
                     FROM contract_state cs
                     INNER JOIN (
                         SELECT MAX(id) as max_id
                         FROM contract_state
                         WHERE contract_index = ?
                         GROUP BY ` + (stateKeyBin ? 'state_key_bin' : 'state_key') + `
                     ) latest ON cs.id = latest.max_id
                     WHERE cs.state_value IS NOT NULL`;
        let results = await this.doQuery(query, [contractIndex]);
        // Null-prototype object so adversarial keys round-trip faithfully. A
        // plain {} would route state['__proto__'] = value through the __proto__
        // setter - a no-op for non-object values (silently dropping the key) or
        // a prototype reassignment for object values. The VM's StateManager
        // already uses Object.create(null) and lets contracts state.set('__proto__'),
        // so the reload path must preserve it too, else that key vanishes on the
        // next EXECUTE.
        let state = Object.create(null);
        for(let row of results){
            try {
                state[row.state_key] = JSON.parse(row.state_value);
            } catch(e){
                state[row.state_key] = row.state_value;
            }
        }
        return state;
    },

    // Append a new state row (append-only - rollback via DELETE WHERE block_index >= ?)
    async createContractState(data){
        let query = `INSERT INTO contract_state
                        (contract_index, state_key, state_value, block_index, action_index)
                     VALUES (?, ?, ?, ?, ?)`;
        let args = [
            data['CONTRACT_INDEX'],
            data['STATE_KEY'],
            data['STATE_VALUE'],
            data['BLOCK_INDEX'],
            data['ACTION_INDEX']
        ];
        await this.doQuery(query, args);
    },

    // How many contract_emissions rows an execution has already recorded. Guard emissions
    // share their host action's execution_index, so a caller offsets its next position by
    // this count to keep (execution_index, position) globally unique; that is what makes
    // the read-side ORDER BY a total order with no engine-dependent tie-break, and so no
    // fork. Runs on the caller's connection, which is inside the guard's savepoint: a
    // rolled-back guard's emissions must not be counted, or positions gap and diverge.
    async countContractEmissionsForExecution(executionIndex){
        let results = await this.doQuery(
            'SELECT COUNT(*) AS cnt FROM contract_emissions WHERE execution_index=?',
            [executionIndex]);
        return (results.length > 0) ? Number(results[0].cnt) : 0;
    },

    // Create a record in contract_emissions
    async createContractEmission(data){
        let query = `INSERT INTO contract_emissions
                        (execution_index, emitted_action, action_index, position)
                     VALUES (?, ?, ?, ?)`;
        let args = [
            data['EXECUTION_INDEX'],
            data['EMITTED_ACTION'],
            data['ACTION_INDEX'],
            data['POSITION']
        ];
        await this.doQuery(query, args);
    },

    // Delete a contract record (for constructor failure rollback)
    async deleteContract(actionIndex){
        let query = `DELETE FROM contracts WHERE action_index=?`;
        await this.doQuery(query, [actionIndex]);
        // A contract's permissions manifest (Phase E) is persisted under the same
        // DEPLOY action_index, so a failed/cleaned-up deploy must drop it too.
        await this.doQuery(`DELETE FROM contract_permissions WHERE action_index=?`, [actionIndex]);
    },

};
