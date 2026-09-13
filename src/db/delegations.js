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
 * XChain Indexer - Database mixin: delegations
 * 
 * The queries over the delegations table family in src/sql/. Installed onto Database.prototype by
 * db/index.js, so call sites stay this.db.<method>().
 *
 ********************************************************************/

module.exports = {

    // Create/Update record in `delegations` table
    async createDelegation(data){
        data                  = this.normalizeDataValues(data);
        let status_id         = await this.createStatus(data['STATUS']);
        let source_id         = await this.getAddressId(data['SOURCE']);
        let signing_pubkey_id = await this.getOrCreatePubkeyId(data['SIGNING_PUBKEY']);
        let action_index      = data['ACTION_INDEX'];
        let block_index       = data['BLOCK_INDEX'];
        let activation_block  = data['ACTIVATION_BLOCK'] || 0;
        // Check if record already exists
        let query  = "SELECT action_index FROM delegations WHERE action_index=? LIMIT 1";
        let args   = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            query = `UPDATE delegations SET
                        source_id=?, signing_pubkey_id=?, status_id=?, block_index=?, activation_block=?
                    WHERE action_index=?`;
            args = [source_id, signing_pubkey_id, status_id, block_index, activation_block, action_index];
        } else {
            query = `INSERT INTO delegations
                        (source_id, signing_pubkey_id, status_id, block_index, activation_block, action_index)
                    VALUES (?, ?, ?, ?, ?, ?)`;
            args = [source_id, signing_pubkey_id, status_id, block_index, activation_block, action_index];
        }
        await this.doQuery(query, args);
    },

    // Set the deactivation_block for an active delegation
    // Used by createRevokeDelegation flow to mark when the delegation should be removed
    async setDelegationDeactivation(source, pubkey, deactivationBlock){
        let source_id = await this.getAddressId(source);
        let pubkey_id = await this.getPubkeyId(String(pubkey).toLowerCase());
        if(source_id === null || pubkey_id === null) return false;
        let valid_id = await this.getStatusId('valid');
        let query = `UPDATE delegations SET deactivation_block=?
                     WHERE source_id=? AND signing_pubkey_id=? AND status_id=? AND deactivation_block IS NULL`;
        await this.doQuery(query, [deactivationBlock, source_id, pubkey_id, valid_id]);
        return true;
    },

    // Stamp EVERY active delegation of a source, which setDelegationDeactivation
    // cannot do: it stamps one (source, pubkey) pair, so an evicted source keeping
    // any delegated key would stay inside the capability predicate through the
    // DELEGATE branch and the eviction would not remove it.
    async setAllDelegationDeactivationsBySource(source, deactivationBlock){
        let source_id = await this.getAddressId(source);
        if(source_id === null) return 0;
        let valid_id = await this.getStatusId('valid');
        let query = `UPDATE delegations SET deactivation_block=?
                     WHERE source_id=? AND status_id=? AND deactivation_block IS NULL`;
        let result = await this.doQuery(query, [deactivationBlock, source_id, valid_id]);
        return (result && result.affectedRows !== undefined) ? result.affectedRows : 0;
    },

    // Resolve an equivocating DELEGATED signing key to the stake source that backs it.
    //
    // A delegated key signs on behalf of a staker but owns no stake itself: the
    // `stakes` rows carry the OWNER's source_id and (for delegation-only stakers) a
    // different signing_pubkey_id entirely. slashCapabilityStake burns by
    // signing_pubkey_id, so a proof against a delegated key matched zero rows and
    // burned NOTHING while still recording a valid slash event. Equivocation via a
    // delegated key was therefore free, which is the whole point of the bond.
    //
    // The mapping is read AT THE EQUIVOCATION HEIGHT, not at processing time. That is
    // the pinned resolution (spec P7): the delegation that was in force when the
    // offence happened is the one that identifies the responsible stake, so an
    // offender cannot revoke the delegation afterwards to orphan the proof, and the
    // answer is a pure function of the proof rather than of when it was submitted.
    // Returns the owning source_id, or null when the key was not a delegated key at
    // that height (in which case it stakes in its own name and the caller's existing
    // signing_pubkey_id burn is already correct).
    async getStakeSourceForDelegatedPubkey(pubkeyId, equivocationBlock){
        if(pubkeyId === null || pubkeyId === undefined) return null;
        let valid_id = await this.getStatusId('valid');
        if(valid_id === null) return null;
        let blk = parseInt(equivocationBlock);
        if(!Number.isFinite(blk)) return null;
        // Active AT the equivocation height: activated at or before it, and not yet
        // deactivated as of it. Deliberately the same window predicate the capability
        // set uses, so a key that was eligible to sign is a key that resolves here.
        let query = `SELECT source_id FROM delegations
                     WHERE signing_pubkey_id=? AND status_id=?
                       AND activation_block <= ?
                       AND (deactivation_block IS NULL OR deactivation_block > ?)
                     ORDER BY action_index DESC LIMIT 1`;
        let rows = await this.doQuery(query, [pubkeyId, valid_id, blk, blk]);
        return rows.length > 0 ? rows[0].source_id : null;
    },

    // Get the delegation holding a pubkey, regardless of source - used for the
    // DELEGATE v0 pubkey-collision rule ("must not already be in use by any
    // active stake or delegation"). Pending-activation delegations already
    // reserve the pubkey (mirrors the stake-collision semantics), so only the
    // deactivation gate is applied: a revoked delegation frees the pubkey.
    async getDelegationByPubkey(pubkey, blockIndex){
        let pubkey_id = await this.getPubkeyId(String(pubkey).toLowerCase());
        if(pubkey_id === null)
            return null;
        let valid_id = await this.getStatusId('valid');
        let query = `SELECT * FROM delegations
                     WHERE signing_pubkey_id=? AND status_id=?
                       AND (deactivation_block IS NULL OR deactivation_block > ?)
                     ORDER BY action_index DESC LIMIT 1`;
        let results = await this.doQuery(query, [pubkey_id, valid_id, blockIndex]);
        if(results.length > 0)
            return results[0];
        return null;
    },

    // Get active delegation for a source + pubkey (gated by activation/deactivation delay)
    async getActiveDelegation(source, pubkey, blockIndex){
        let source_id = await this.getAddressId(source);
        let pubkey_id = await this.getPubkeyId(String(pubkey).toLowerCase());
        if(source_id === null || pubkey_id === null)
            return null;
        let valid_id = await this.getStatusId('valid');
        let query = `SELECT * FROM delegations WHERE source_id=? AND signing_pubkey_id=? AND status_id=?`;
        let args = [source_id, pubkey_id, valid_id];
        if(blockIndex !== undefined && blockIndex !== null){
            query += ' AND activation_block <= ? AND (deactivation_block IS NULL OR deactivation_block > ?)';
            args.push(blockIndex);
            args.push(blockIndex);
        }
        query += ' ORDER BY action_index DESC LIMIT 1';
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            return results[0];
        return null;
    },


    // The delegation leg of getstakesourcebypubkey: the source address a signing pubkey
    // resolves to when no STAKE row claims it. Same active-row rules as the stake leg in
    // db/stakes.js, minus the stake-key revocation clause, which has no delegation analogue.
    async getDelegationSourceAddressBySigningPubkey(pubkeyId, validId, blockIndex){
        return await this.doQuery(
            `SELECT ia.address AS source FROM delegations d
                 JOIN index_addresses ia ON ia.id = d.source_id
                 WHERE d.signing_pubkey_id = ? AND d.status_id = ?
                   AND d.activation_block <= ?
                   AND (d.deactivation_block IS NULL OR d.deactivation_block > ?)
                   AND NOT EXISTS (
                       SELECT 1 FROM capability_slash_events cse
                       WHERE cse.signing_pubkey_id = d.signing_pubkey_id
                         AND cse.block_index <= ?)
                 ORDER BY d.action_index DESC LIMIT 1`,
            [pubkeyId, validId, blockIndex, blockIndex, blockIndex]);
    },


    // Does an ACTIVE contract stake back this (contract, source, tick) at this height? A
    // DELEGATE v1 needs one: without it the delegation row it writes has no deactivation
    // block and outlives the stake once the cooldown sweeps the tokens out, leaving a
    // contract-signer authority with nothing staked behind it.
    async hasActiveContractStakeForDelegation(targetContractIndex, sourceId, tickId, validId, blockIndex){
        let rows = await this.doQuery(
            `SELECT 1 FROM contract_stakes
                     WHERE target_contract_index=? AND source_id=? AND tick_id=? AND status_id=?
                       AND activation_block <= ? AND deactivation_block IS NULL
                     LIMIT 1`,
            [targetContractIndex, sourceId, tickId, validId, blockIndex]);
        return rows.length > 0;
    },

    // Is this signing pubkey already claimed by a contract STAKE? Half of the DELEGATE v1
    // collision check, which is scoped to contract rows only: the same pubkey may be a
    // capability validator and a contract staker, and only reuse inside contract scope is
    // refused.
    async isSigningPubkeyUsedByContractStake(pubkeyId, validId){
        let rows = await this.doQuery(
            `SELECT 1 FROM contract_stakes WHERE signing_pubkey_id=? AND status_id=? LIMIT 1`,
            [pubkeyId, validId]);
        return rows.length > 0;
    },

    // The other half of that collision check: already claimed by a contract DELEGATION.
    async isSigningPubkeyUsedByContractDelegation(pubkeyId, validId){
        let rows = await this.doQuery(
            `SELECT 1 FROM contract_delegations WHERE signing_pubkey_id=? AND status_id=? LIMIT 1`,
            [pubkeyId, validId]);
        return rows.length > 0;
    },

    // Is there an ACTIVE contract delegation to revoke at this height? DELEGATE v3 refuses
    // when there is not. Active spans the activation delay in both directions: already
    // activated, and not yet deactivated as of this block.
    async hasActiveContractDelegation(targetContractIndex, sourceId, pubkeyId, tickId, validId, blockIndex){
        let rows = await this.doQuery(
            `SELECT 1 FROM contract_delegations
                     WHERE target_contract_index=? AND source_id=? AND signing_pubkey_id=? AND tick_id=?
                       AND status_id=? AND activation_block <= ?
                       AND (deactivation_block IS NULL OR deactivation_block > ?)
                     LIMIT 1`,
            [targetContractIndex, sourceId, pubkeyId, tickId, validId, blockIndex, blockIndex]);
        return rows.length > 0;
    },

    // Stamp the revoking height onto the live contract delegation rows for this
    // (contract, pubkey, tick). Only rows still open (deactivation_block IS NULL) are
    // touched, so a second revoke cannot move a deactivation height already set.
    async deactivateContractDelegation(deactivationBlock, targetContractIndex, pubkeyId, tickId, validId){
        await this.doQuery(
            `UPDATE contract_delegations SET deactivation_block=?
                 WHERE target_contract_index=? AND signing_pubkey_id=? AND tick_id=?
                   AND status_id=? AND deactivation_block IS NULL`,
            [deactivationBlock, targetContractIndex, pubkeyId, tickId, validId]);
    },

};
