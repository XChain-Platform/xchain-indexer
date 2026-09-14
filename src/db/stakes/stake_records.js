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
 * XChain Indexer - Database mixin part: stakes / stake_records
 *
 * The row writers for stakes, unstakes and stake_key_revocations, and the two per-row
 * reads that look one of those rows up by source and key.
 * Merged into the stakes mixin by db/stakes.js, which db/index.js installs
 * onto Database.prototype, so call sites stay this.db.<method>().
 *
 ********************************************************************/

module.exports = {

    /*
     * Staking action methods
     */

    // Create/Update record in `stakes` table.
    // Capability model: each STAKE action (v1 create or v2 top-up) gets its own row.
    // Active stake amount for a pubkey is SUM(amount) across all valid rows.
    async createStake(data){
        data                  = this.normalizeDataValues(data);
        let status_id         = await this.createStatus(data['STATUS']);
        let source_id         = await this.getAddressId(data['SOURCE']);
        let signing_pubkey_id = await this.getOrCreatePubkeyId(data['SIGNING_PUBKEY']);
        let action_index      = data['ACTION_INDEX'];
        let version           = data['VERSION'] || 1;
        let amount            = data['AMOUNT'] || '0';
        let block_index       = data['BLOCK_INDEX'];
        let activation_block  = data['ACTIVATION_BLOCK'] || 0;
        // Check if record already exists
        let query  = "SELECT action_index FROM stakes WHERE action_index=? LIMIT 1";
        let args   = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            query = `UPDATE stakes SET
                        source_id=?, version=?, signing_pubkey_id=?,
                        amount=?, status_id=?, block_index=?, activation_block=?
                    WHERE action_index=?`;
            args = [source_id, version, signing_pubkey_id, amount, status_id, block_index, activation_block, action_index];
        } else {
            query = `INSERT INTO stakes
                        (source_id, version, signing_pubkey_id, amount, status_id, block_index, activation_block, action_index)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
            args = [source_id, version, signing_pubkey_id, amount, status_id, block_index, activation_block, action_index];
        }
        await this.doQuery(query, args);
    },

    // Set deactivation_block for the ALREADY-ACTIVE stake rows owned by the given pubkey.
    // Used by createUnstake to mark when a pubkey's stake (original + activated top-ups) should be
    // removed from the active set. The `currentBlock` filter (activation_block <= currentBlock) is
    // load-bearing: the unstake AMOUNT is summed from active rows only (getActiveStakeByPubkey), so a
    // pending-activation top-up (activation_block > currentBlock) must NOT be deactivated here - it
    // was never counted in the unstake and the cooldown sweep would never refund it, orphaning the
    // tokens. It correctly stays an active stake until a later UNSTAKE covers it.
    async setStakeDeactivationByPubkey(pubkey, deactivationBlock, currentBlock){
        let pubkey_id = await this.getPubkeyId(String(pubkey).toLowerCase());
        if(pubkey_id === null) return false;
        let valid_id = await this.getStatusId('valid');
        let query = `UPDATE stakes SET deactivation_block=?
                     WHERE signing_pubkey_id=? AND status_id=? AND deactivation_block IS NULL
                       AND activation_block <= ?`;
        await this.doQuery(query, [deactivationBlock, pubkey_id, valid_id, currentBlock]);
        return true;
    },

    // Create/Update record in `unstakes` table
    async createUnstake(data){
        data                  = this.normalizeDataValues(data);
        let status_id         = await this.createStatus(data['STATUS']);
        let source_id         = await this.getAddressId(data['SOURCE']);
        let signing_pubkey_id = await this.getOrCreatePubkeyId(data['SIGNING_PUBKEY']);
        let action_index      = data['ACTION_INDEX'];
        let cooldown_end_block = data['COOLDOWN_END_BLOCK'];
        let amount            = data['AMOUNT'] || '0';
        let block_index       = data['BLOCK_INDEX'];
        // Check if record already exists
        let query  = "SELECT action_index FROM unstakes WHERE action_index=? LIMIT 1";
        let args   = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            query = `UPDATE unstakes SET
                        source_id=?, signing_pubkey_id=?, cooldown_end_block=?,
                        amount=?, status_id=?, block_index=?
                    WHERE action_index=?`;
            args = [source_id, signing_pubkey_id, cooldown_end_block, amount, status_id, block_index, action_index];
        } else {
            query = `INSERT INTO unstakes
                        (source_id, signing_pubkey_id, cooldown_end_block, amount, status_id, block_index, action_index)
                    VALUES (?, ?, ?, ?, ?, ?, ?)`;
            args = [source_id, signing_pubkey_id, cooldown_end_block, amount, status_id, block_index, action_index];
        }
        await this.doQuery(query, args);
    },

    // Create/Update record in `stake_key_revocations` table (DELEGATE v2 against
    // the source's ORIGINAL stake signing key - the delegation-row revoke path
    // stays in `delegations`). `deactivation_block` is when the key stops being
    // a valid signer; a LATER re-stake of the same key (higher action_index)
    // clears the revocation (see _effectiveCapabilitySetSql).
    async createStakeKeyRevocation(data){
        data                  = this.normalizeDataValues(data);
        let status_id         = await this.createStatus(data['STATUS']);
        let source_id         = await this.getAddressId(data['SOURCE']);
        let signing_pubkey_id = await this.getOrCreatePubkeyId(data['SIGNING_PUBKEY']);
        let action_index      = data['ACTION_INDEX'];
        let block_index       = data['BLOCK_INDEX'];
        let deactivation_block = data['DEACTIVATION_BLOCK'] || 0;
        let query  = "SELECT action_index FROM stake_key_revocations WHERE action_index=? LIMIT 1";
        let results = await this.doQuery(query, [action_index]);
        let args;
        if(results.length > 0){
            query = `UPDATE stake_key_revocations SET
                        source_id=?, signing_pubkey_id=?, status_id=?, block_index=?, deactivation_block=?
                    WHERE action_index=?`;
            args = [source_id, signing_pubkey_id, status_id, block_index, deactivation_block, action_index];
        } else {
            query = `INSERT INTO stake_key_revocations
                        (source_id, signing_pubkey_id, status_id, block_index, deactivation_block, action_index)
                    VALUES (?, ?, ?, ?, ?, ?)`;
            args = [source_id, signing_pubkey_id, status_id, block_index, deactivation_block, action_index];
        }
        await this.doQuery(query, args);
    },

    // Get the latest valid stake-key revocation for (source, pubkey) that applies
    // to stakes at or before `sinceActionIndex` (i.e. would suppress that stake row).
    async getStakeKeyRevocation(source, pubkey, sinceActionIndex){
        let source_id = await this.getAddressId(source);
        let pubkey_id = await this.getPubkeyId(String(pubkey).toLowerCase());
        if(source_id === null || pubkey_id === null) return null;
        let valid_id = await this.getStatusId('valid');
        let query = `SELECT * FROM stake_key_revocations
                     WHERE source_id=? AND signing_pubkey_id=? AND status_id=?
                       AND action_index > ?
                     ORDER BY action_index DESC LIMIT 1`;
        let results = await this.doQuery(query, [source_id, pubkey_id, valid_id, Number(sinceActionIndex) || 0]);
        return results.length > 0 ? results[0] : null;
    },

    // Get the source's active stake row bound to a specific signing pubkey at a block
    async getActiveStakeBySourceAndPubkey(source, pubkey, blockIndex){
        let source_id = await this.getAddressId(source);
        let pubkey_id = await this.getPubkeyId(String(pubkey).toLowerCase());
        if(source_id === null || pubkey_id === null) return null;
        let valid_id = await this.getStatusId('valid');
        let query = `SELECT * FROM stakes
                     WHERE source_id=? AND signing_pubkey_id=? AND status_id=?
                       AND activation_block <= ?
                       AND (deactivation_block IS NULL OR deactivation_block > ?)
                     ORDER BY action_index DESC LIMIT 1`;
        let results = await this.doQuery(query, [source_id, pubkey_id, valid_id, blockIndex, blockIndex]);
        return results.length > 0 ? results[0] : null;
    },

};
