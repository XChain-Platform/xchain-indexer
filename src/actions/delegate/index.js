const { getLogger } = require('../../observability/index.js');
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
 * XChain Platform Action - DELEGATE
 *
 * Manages the signing key bound to a staked validator. Four flavors:
 *   v0: Capability rotate (rotate the signing key for a capability stake)
 *   v1: Contract-targeted rotate (rotate the signing key for a contract-targeted stake)
 *   v2: Capability revoke (remove a previously delegated capability signing key)
 *   v3: Contract-targeted revoke (remove a previously delegated contract-targeted signing key)
 *
 * Capability flavors (v0/v2): BTC chain only.
 * Contract-targeted flavors (v1/v3): any chain (BTC, LTC, DOGE).
 *
 * FORMATS:
 *   v0 - VERSION|NEW_SIGNING_PUBKEY                                     (capability rotate)
 *   v1 - VERSION|NEW_SIGNING_PUBKEY|TARGET_CONTRACT_INDEX|TICK          (contract-targeted rotate)
 *   v2 - VERSION|SIGNING_PUBKEY                                         (capability revoke)
 *   v3 - VERSION|SIGNING_PUBKEY|TARGET_CONTRACT_INDEX|TICK              (contract-targeted revoke)
 *
 ********************************************************************/

// Wire-field validation and settlement, installed onto Delegate.prototype below
const validatePart = require('./validate.js');
const settlePart   = require('./settle.js');

class Delegate {

    // Handle constructing a class instance
    constructor(action){
        // Setup short aliases
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;

        // Define list of known FORMATS
        this.formats = {};
        this.formats[0] = 'VERSION|NEW_SIGNING_PUBKEY';                                       // capability rotate
        this.formats[1] = 'VERSION|NEW_SIGNING_PUBKEY|TARGET_CONTRACT_INDEX|TICK';            // contract-targeted rotate
        this.formats[2] = 'VERSION|SIGNING_PUBKEY';                                           // capability revoke
        this.formats[3] = 'VERSION|SIGNING_PUBKEY|TARGET_CONTRACT_INDEX|TICK';                // contract-targeted revoke
    }

    // Handle parsing the DELEGATE transaction
    async parse(params, data, error){

        // Validate that format is known
        let format = data['FORMAT'];
        if(!error && (format===null || this.formats[format] === undefined ))
            error = 'invalid: VERSION (unknown)';

        // Dispatch by version
        if(!error && format === 1) return await this.parseContractDelegate(params, data, error);
        if(!error && format === 2) return await this.parseCapabilityRevoke(params, data, error);
        if(!error && format === 3) return await this.parseContractRevoke(params, data, error);

        // Extract params (v0 capability delegation)
        data['SIGNING_PUBKEY'] = params[1];

        // Convert NUMBER fields from string value to number value
        if(!error)
            data = this.util.setNumberFormats(data);

        /*****************************************************************
         * Chain Restriction
         ****************************************************************/

        // Capability delegation (v0) is BTC-only
        if(!error && data['COIN'] !== 'BTC')
            error = 'invalid: ACTION (BTC only)';

        /*****************************************************************
         * SIGNING_PUBKEY Validations
         ****************************************************************/

        // Verify SIGNING_PUBKEY is provided and is 64 hex characters (Ed25519) (delegate/validate.js)
        error = this.validateSigningPubkey(data, error);

        /*****************************************************************
         * Stake Existence Validations
         ****************************************************************/

        // SOURCE must hold an active stake, the new key must be free of every stake and
        // delegation, and SOURCE must not be sleeping
        error = await this.checkCapabilityRotate(data, error);

        // Calculate the activation block (per-chain ACTIVATION_DELAY_BLOCKS, calibrated for ~60 min reorg protection on each chain)
        data['ACTIVATION_BLOCK'] = parseInt(data['BLOCK_INDEX']) + this.activationDelay();

        // Determine final status
        let status = (error) ? error : 'valid';
        data['STATUS'] = status;

        // Print status message
        getLogger().info("\t DELEGATE : pubkey=" + data['SIGNING_PUBKEY'] + ' : ' + data['STATUS']);

        // Create record in delegations table
        await this.indexerDb.createDelegation(data);

        // Post the ledger changes and refresh balances, supply and mappings (delegate/settle.js)
        await this.postLedgerChanges(data, this.config['GAS']);
    }

    // DELEGATE v0 stake checks: SOURCE's own stake, then pubkey collisions, then sleep
    async checkCapabilityRotate(data, error){

        // Verify SOURCE has an active stake (gated by activation delay)
        if(!error){
            let activeStake = await this.indexerDb.getActiveStakeBySource(data['SOURCE'], data['BLOCK_INDEX']);
            if(!activeStake)
                error = 'invalid: no active stake';
        }

        // Check that the new signing pubkey is not already in use
        // Pubkey collision is checked across ALL stakes (including pending activation)
        if(!error){
            let existingStake = await this.indexerDb.getActiveStakeByPubkey(data['SIGNING_PUBKEY']);
            if(existingStake)
                error = 'invalid: SIGNING_PUBKEY (already in use)';
        }

        // ... and not already held by another active (or pending-activation)
        // delegation. Spec: "NEW_SIGNING_PUBKEY must not already be in use by
        // any active stake or delegation." A revoked delegation
        // (deactivation_block <= height) frees the pubkey for reuse.
        if(!error){
            let existingDelegation = await this.indexerDb.getDelegationByPubkey(data['SIGNING_PUBKEY'], data['BLOCK_INDEX']);
            if(existingDelegation)
                error = 'invalid: SIGNING_PUBKEY (already delegated)';
        }

        // Verify SOURCE is not sleeping
        if(!error && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
            error = 'invalid: SOURCE (sleeping)';

        return error;
    }

    // DELEGATE v1: rotate signing key for a contract-targeted stake.
    // Scoped to (target_contract_index, tick); pubkey-collision check is restricted to
    // contract_* tables so a single pubkey CAN serve as both a capability validator
    // and a contract staker simultaneously.
    async parseContractDelegate(params, data, error){

        // Extract params
        data['SIGNING_PUBKEY']        = params[1];
        data['TARGET_CONTRACT_INDEX'] = params[2];
        data['TICK']                  = params[3];

        // Convert NUMBER fields from string value to number value
        if(!error)
            data = this.util.setNumberFormats(data);

        // Verify SIGNING_PUBKEY is provided + format, then the (target, tick) slot (delegate/validate.js)
        error = this.validateSigningPubkey(data, error);
        error = await this.validateContractSlot(data, error);

        // SOURCE must back the slot with a live stake and the new key must be free in contract scope
        error = await this.checkContractRotate(data, error);

        // Verify SOURCE is not sleeping
        if(!error && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
            error = 'invalid: SOURCE (sleeping)';

        data['ACTIVATION_BLOCK'] = parseInt(data['BLOCK_INDEX']) + this.activationDelay();

        let status = (error) ? error : 'valid';
        data['STATUS'] = status;

        getLogger().info("\t DELEGATE v1 : pubkey=" + String(data['SIGNING_PUBKEY']).substring(0, 16) +
            '... : target=' + data['TARGET_CONTRACT_INDEX'] +
            ' : tick=' + data['TICK'] +
            ' : ' + data['STATUS']);

        await this.indexerDb.createContractDelegation(data);

        // Post the ledger changes against the staked TICK (delegate/settle.js)
        await this.postLedgerChanges(data, data['TICK']);
    }

    // DELEGATE v1 slot checks: SOURCE's backing contract stake, then the contract-scope
    // pubkey collision
    async checkContractRotate(data, error){

        // Source must own an active contract-stake for (target, *, tick); any pubkey on this slot
        if(!error){
            // Reuse getActiveContractStakeByPubkey requires a known pubkey; instead check via owner lookup.
            // We don't know the OLD pubkey from the wire; pubkey rotation just claims a new one.
            // Validate by sweep: does SOURCE own a fully-active contract_stakes row for (target, tick)?
            // deactivation_block must be NULL, not merely in the future: a row whose UNSTAKE has set
            // deactivation_block = block + activationDelay is mid-cooldown, its tokens already committed
            // to a contract_unstakes return. Accepting a rotate there would bind a new signing pubkey
            // (deactivation_block = NULL) that outlives the backing stake once the cooldown sweeps the
            // tokens out, leaving a contract-signer authority with no stake behind it.
            let sourceId = await this.indexerDb.getAddressId(data['SOURCE']);
            if(sourceId === null){
                error = 'invalid: SOURCE (no active contract stake)';
            } else {
                let valid_id = await this.indexerDb.getStatusId('valid');
                let tick_id  = await this.indexerDb.getTickerId(data['TICK']);
                let backed = await this.indexerDb.hasActiveContractStakeForDelegation(
                    Number(data['TARGET_CONTRACT_INDEX']), sourceId, tick_id, valid_id, data['BLOCK_INDEX']);
                if(!backed)
                    error = 'invalid: SOURCE (no active contract stake)';
            }
        }

        // Pubkey-collision check: scoped to contract_stakes and contract_delegations only.
        // A pubkey can be a capability validator AND a contract staker; only block reuse within contract scope.
        if(!error){
            let valid_id = await this.indexerDb.getStatusId('valid');
            let pubkey_id = await this.indexerDb.getPubkeyId(String(data['SIGNING_PUBKEY']).toLowerCase());
            if(pubkey_id !== null){
                if(await this.indexerDb.isSigningPubkeyUsedByContractStake(pubkey_id, valid_id)){
                    error = 'invalid: SIGNING_PUBKEY (already in use by contract stake)';
                } else if(await this.indexerDb.isSigningPubkeyUsedByContractDelegation(pubkey_id, valid_id)){
                    error = 'invalid: SIGNING_PUBKEY (already in use by contract delegation)';
                }
            }
        }

        return error;
    }

    // DELEGATE v2: capability revoke. Removes a previously delegated signing key
    // without replacing it. Marks `deactivation_block` (BLOCK_INDEX + activation delay)
    // on the matching capability delegation row.
    async parseCapabilityRevoke(params, data, error){

        // Extract params
        data['SIGNING_PUBKEY'] = params[1];

        // Convert NUMBER fields from string value to number value
        if(!error)
            data = this.util.setNumberFormats(data);

        // Capability revoke (v2) is BTC-only
        if(!error && data['COIN'] !== 'BTC')
            error = 'invalid: ACTION (BTC only)';

        // Verify SIGNING_PUBKEY is provided + format (delegate/validate.js)
        error = this.validateSigningPubkey(data, error);

        // Resolve the revocation target. v2 revokes either:
        //   - a previously delegated key (a `delegations` row), or
        //   - the source's ORIGINAL stake signing key (required for the
        //     key-compromise procedure to complete: a compromised stake key must
        //     be revocable once a replacement is delegated via v0). Recorded in
        //     `stake_key_revocations`; re-staking the same key later (STAKE v2)
        //     clears the revocation.
        let stakeKeyMode;
        ({ error, stakeKeyMode } = await this.resolveRevokeTarget(data, error));

        // Verify SOURCE is not sleeping
        if(!error && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
            error = 'invalid: SOURCE (sleeping)';

        let status = (error) ? error : 'valid';
        data['STATUS'] = status;

        getLogger().info("\t DELEGATE v2 (revoke" + (stakeKeyMode ? ', stake key' : '') + ") : pubkey=" + data['SIGNING_PUBKEY'] + ' : ' + data['STATUS']);

        // Record the revocation: a stake-key revocation row, or the parent delegation's deactivation
        await this.recordCapabilityRevoke(data, status, stakeKeyMode);

        // Store the SOURCE in addresses list, then post the ledger changes (delegate/settle.js)
        await this.postLedgerChanges(data, this.config['GAS']);
    }

    // DELEGATE v2 writes, keyed on which target resolveRevokeTarget (delegate/validate.js) found
    async recordCapabilityRevoke(data, status, stakeKeyMode){
        let activationDelay = this.activationDelay();

        if(stakeKeyMode){
            // Stake-key revocation: recorded ONLY in stake_key_revocations. A
            // delegations record here would read as an ACTIVE delegation of the
            // revoked key and re-add it to the effective signer set.
            data['DEACTIVATION_BLOCK'] = parseInt(data['BLOCK_INDEX']) + activationDelay;
            await this.indexerDb.createStakeKeyRevocation(data);
        } else {
            // Gated by DELEGATE_REVOKE_NO_REINSERT: mirror the v3 contract-revoke path -
            // deactivate the PARENT delegation only, do NOT insert a fresh row. The legacy path
            // (createRevokeDelegation -> createDelegation) INSERTed a status=valid, activation_block=0
            // delegations row, so a second revoke before the first matured extended the revoked key's
            // signer lifetime, and the stray activation_block=0 rows misrepresent historical as-of
            // effective-set reads. At/after the flag-day only the deactivation UPDATE runs (a repeat
            // revoke then no-ops, since the parent already carries a deactivation_block). Below the
            // flag-day the legacy insert+cap is preserved for replay/fleet consistency.
            let noReinsert = await this.actions.protocolChanges.isEnabled('DELEGATE_REVOKE_NO_REINSERT', data['BLOCK_INDEX']);
            if(!noReinsert)
                await this.indexerDb.createRevokeDelegation(data);

            // Mark the parent delegation's deactivation_block (BLOCK_INDEX + activation delay). In the
            // fixed path this is the only delegations write; in the legacy path it also caps the row
            // just inserted above.
            if(status === 'valid')
                await this.indexerDb.setDelegationDeactivation(data['SOURCE'], data['SIGNING_PUBKEY'], parseInt(data['BLOCK_INDEX']) + activationDelay);
        }
    }

    // DELEGATE v3: contract-targeted revoke. Removes a previously delegated signing key
    // scoped to (target_contract_index, signing_pubkey, tick) without replacing it.
    // Marks `deactivation_block` on the matching contract_delegations row.
    async parseContractRevoke(params, data, error){

        // Extract params
        data['SIGNING_PUBKEY']        = params[1];
        data['TARGET_CONTRACT_INDEX'] = params[2];
        data['TICK']                  = params[3];

        // Convert NUMBER fields from string value to number value
        if(!error)
            data = this.util.setNumberFormats(data);

        // Verify SIGNING_PUBKEY is provided + format, then the (target, tick) slot (delegate/validate.js)
        error = this.validateSigningPubkey(data, error);
        error = await this.validateContractSlot(data, error);

        // Verify SOURCE owns an active contract_delegations row for (target, pubkey, tick)
        if(!error){
            let valid_id  = await this.indexerDb.getStatusId('valid');
            let source_id = await this.indexerDb.getAddressId(data['SOURCE']);
            let pubkey_id = await this.indexerDb.getPubkeyId(String(data['SIGNING_PUBKEY']).toLowerCase());
            let tick_id   = await this.indexerDb.getTickerId(data['TICK']);
            if(source_id === null || pubkey_id === null || tick_id === null){
                error = 'invalid: no active contract delegation';
            } else {
                let active = await this.indexerDb.hasActiveContractDelegation(
                    Number(data['TARGET_CONTRACT_INDEX']), source_id, pubkey_id, tick_id, valid_id,
                    data['BLOCK_INDEX']);
                if(!active)
                    error = 'invalid: no active contract delegation';
            }
        }

        // Verify SOURCE is not sleeping
        if(!error && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
            error = 'invalid: SOURCE (sleeping)';

        let status = (error) ? error : 'valid';
        data['STATUS'] = status;

        getLogger().info("\t DELEGATE v3 (contract revoke) : pubkey=" + String(data['SIGNING_PUBKEY']).substring(0,16) +
                    '... : target=' + data['TARGET_CONTRACT_INDEX'] +
                    ' : tick=' + data['TICK'] +
                    ' : ' + data['STATUS']);

        // Mark the contract_delegations row's deactivation_block (delegate/settle.js)
        if(status === 'valid')
            await this.deactivateContractSlot(data);

        // Post the ledger changes against the staked TICK (delegate/settle.js)
        await this.postLedgerChanges(data, data['TICK']);
    }
}

// Install the parts from delegate/ NON-ENUMERABLE, the shape the class body they came from
// produced: the parse methods reach them as this.<method>, suites can stub them through
// Delegate.prototype, and for-in over a handler stays empty. Same install as db/index.js uses
// for its query mixins.
for(const part of [validatePart, settlePart]){
    const descriptors = Object.getOwnPropertyDescriptors(part);
    for(const key of Reflect.ownKeys(descriptors)) descriptors[key].enumerable = false;
    Object.defineProperties(Delegate.prototype, descriptors);
}

module.exports = Delegate;
