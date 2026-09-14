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
 * XChain Indexer - Database mixin part: contracts / stakes
 *
 * The contract-targeted STAKE v3 / UNSTAKE v1 / DELEGATE v1 record writers and the
 * active-stake reads over contract_stakes.
 * Merged into the contracts mixin by db/contracts.js, which db/index.js installs
 * onto Database.prototype, so call sites stay this.db.<method>().
 *
 ********************************************************************/

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
        let { amount, source_id, activation_block, block_index } = stakeAggregates.sumRows(this.util, results, decimals);
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

};

// The row aggregation of getActiveContractStakeByPubkey, kept off the exported object so
// Database.prototype gains no method. Sums the raw amounts with the bignumber wrapper at
// `decimals` and takes the MIN of each id column, as the prior GROUP BY row did.
const stakeAggregates = {

    sumRows(util, results, decimals){
        let amount = '0';
        let source_id = null, activation_block = null, block_index = null;
        for(let row of results){
            amount = util.bcadd(amount, row.amount, decimals);
            let rSource = (row.source_id === null || row.source_id === undefined) ? null : Number(row.source_id);
            if(rSource !== null && (source_id === null || rSource < source_id)) source_id = rSource;
            let rAct = (row.activation_block === null || row.activation_block === undefined) ? null : Number(row.activation_block);
            if(rAct !== null && (activation_block === null || rAct < activation_block)) activation_block = rAct;
            let rBlk = (row.block_index === null || row.block_index === undefined) ? null : Number(row.block_index);
            if(rBlk !== null && (block_index === null || rBlk < block_index)) block_index = rBlk;
        }
        // bcadd returns a bignumber; emit the canonical fixed-precision string the callers expect
        // (matches the prior String(SUM(...)) representation for XCHAIN at 8 dp).
        amount = util.bcformat(amount, decimals);
        return { amount, source_id, activation_block, block_index };
    },

};
