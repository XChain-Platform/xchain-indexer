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
 *   v0 — Capability rotate (rotate the signing key for a capability stake)
 *   v1 — Contract-targeted rotate (rotate the signing key for a contract-targeted stake)
 *   v2 — Capability revoke (remove a previously delegated capability signing key)
 *   v3 — Contract-targeted revoke (remove a previously delegated contract-targeted signing key)
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
        if(!error && format === 1) return await this._parseContractDelegate(params, data, error);
        if(!error && format === 2) return await this._parseCapabilityRevoke(params, data, error);
        if(!error && format === 3) return await this._parseContractRevoke(params, data, error);

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

        // Verify SIGNING_PUBKEY is provided
        if(!error && this.util.isNull(data['SIGNING_PUBKEY']))
            error = 'invalid: SIGNING_PUBKEY (required)';

        // Verify SIGNING_PUBKEY is 64 hex characters (Ed25519)
        if(!error && !/^[0-9a-fA-F]{64}$/.test(data['SIGNING_PUBKEY']))
            error = 'invalid: SIGNING_PUBKEY (format)';

        /*****************************************************************
         * Stake Existence Validations
         ****************************************************************/

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

        // Calculate the activation block (per-chain ACTIVATION_DELAY_BLOCKS, calibrated for ~60 min reorg protection on each chain)
        let staking = this.config['STAKING'];
        let activationDelay = (staking && staking['ACTIVATION_DELAY_BLOCKS']) ? staking['ACTIVATION_DELAY_BLOCKS'] : this.config['ACTIVATION_DELAY_BLOCKS'];
        data['ACTIVATION_BLOCK'] = parseInt(data['BLOCK_INDEX']) + activationDelay;

        // Determine final status
        let status = (error) ? error : 'valid';
        data['STATUS'] = status;

        // Print status message
        console.log("\t DELEGATE : pubkey=" + data['SIGNING_PUBKEY'] + ' : ' + data['STATUS']);

        // Create record in delegations table
        await this.indexerDb.createDelegation(data);

        // Store the SOURCE in addresses list
        this.util.addAddressTicker(data['SOURCE'], this.config['GAS']);

        // Array of credits and debits
        let credits = [],
            debits  = [];

        // Process any transaction ledger changes (credits / debits)
        await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits);

        // Get a list of tickers & addresses
        let tickers   = this.util.getTickersList(),
            addresses = Object.keys(this.util.getAddressesList());

        // Update address balances and token supply
        await this.indexerDb.updateBalances(addresses);
        await this.indexerDb.updateTokens(tickers);

        // Create action mappings
        await this.mapper.createMappings(data);
    }

    // DELEGATE v1 — rotate signing key for a contract-targeted stake.
    // Scoped to (target_contract_index, tick); pubkey-collision check is restricted to
    // contract_* tables so a single pubkey CAN serve as both a capability validator
    // and a contract staker simultaneously (see plan §12.5).
    async _parseContractDelegate(params, data, error){

        // Extract params
        data['SIGNING_PUBKEY']        = params[1];
        data['TARGET_CONTRACT_INDEX'] = params[2];
        data['TICK']                  = params[3];

        if(!error)
            data = this.util.setNumberFormats(data);

        if(!error && this.util.isNull(data['SIGNING_PUBKEY']))
            error = 'invalid: SIGNING_PUBKEY (required)';
        if(!error && !/^[0-9a-fA-F]{64}$/.test(String(data['SIGNING_PUBKEY'])))
            error = 'invalid: SIGNING_PUBKEY (format)';
        if(!error && this.util.isNull(data['TARGET_CONTRACT_INDEX']))
            error = 'invalid: TARGET_CONTRACT_INDEX (required)';
        if(!error && (!/^[0-9]+$/.test(String(data['TARGET_CONTRACT_INDEX'])) || Number(data['TARGET_CONTRACT_INDEX']) <= 0))
            error = 'invalid: TARGET_CONTRACT_INDEX (format)';
        if(!error && this.util.isNull(data['TICK']))
            error = 'invalid: TICK (required)';

        // Source must own an active contract-stake for (target, *, tick) — any pubkey on this slot
        if(!error){
            // Reuse getActiveContractStakeByPubkey requires a known pubkey; instead check via owner lookup.
            // We don't know the OLD pubkey from the wire — pubkey rotation just claims a new one.
            // Validate by sweep: does SOURCE own ANY active contract_stakes row for (target, tick)?
            let sourceId = await this.indexerDb.getAddressId(data['SOURCE']);
            if(sourceId === null){
                error = 'invalid: SOURCE (no active contract stake)';
            } else {
                let valid_id = await this.indexerDb.getStatusId('valid');
                let tick_id  = await this.indexerDb.getTickerId(data['TICK']);
                let rows = await this.indexerDb.doQuery(
                    `SELECT 1 FROM contract_stakes
                     WHERE target_contract_index=? AND source_id=? AND tick_id=? AND status_id=?
                       AND activation_block <= ? AND (deactivation_block IS NULL OR deactivation_block > ?)
                     LIMIT 1`,
                    [Number(data['TARGET_CONTRACT_INDEX']), sourceId, tick_id, valid_id, data['BLOCK_INDEX'], data['BLOCK_INDEX']]
                );
                if(rows.length === 0)
                    error = 'invalid: SOURCE (no active contract stake)';
            }
        }

        // Pubkey-collision check — scoped to contract_stakes and contract_delegations only.
        // A pubkey can be a capability validator AND a contract staker; only block reuse within contract scope.
        if(!error){
            let valid_id = await this.indexerDb.getStatusId('valid');
            let pubkey_id = await this.indexerDb.getPubkeyId(String(data['SIGNING_PUBKEY']).toLowerCase());
            if(pubkey_id !== null){
                let csRows = await this.indexerDb.doQuery(
                    `SELECT 1 FROM contract_stakes WHERE signing_pubkey_id=? AND status_id=? LIMIT 1`,
                    [pubkey_id, valid_id]
                );
                if(csRows.length > 0){
                    error = 'invalid: SIGNING_PUBKEY (already in use by contract stake)';
                } else {
                    let cdRows = await this.indexerDb.doQuery(
                        `SELECT 1 FROM contract_delegations WHERE signing_pubkey_id=? AND status_id=? LIMIT 1`,
                        [pubkey_id, valid_id]
                    );
                    if(cdRows.length > 0)
                        error = 'invalid: SIGNING_PUBKEY (already in use by contract delegation)';
                }
            }
        }

        if(!error && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
            error = 'invalid: SOURCE (sleeping)';

        let staking = this.config['STAKING'];
        let activationDelay = (staking && staking['ACTIVATION_DELAY_BLOCKS']) ? staking['ACTIVATION_DELAY_BLOCKS'] : this.config['ACTIVATION_DELAY_BLOCKS'];
        data['ACTIVATION_BLOCK'] = parseInt(data['BLOCK_INDEX']) + activationDelay;

        let status = (error) ? error : 'valid';
        data['STATUS'] = status;

        console.log("\t DELEGATE v1 : pubkey=" + String(data['SIGNING_PUBKEY']).substring(0, 16) +
            '... : target=' + data['TARGET_CONTRACT_INDEX'] +
            ' : tick=' + data['TICK'] +
            ' : ' + data['STATUS']);

        await this.indexerDb.createContractDelegation(data);

        this.util.addAddressTicker(data['SOURCE'], data['TICK']);

        let credits = [],
            debits  = [];
        await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits);

        let tickers   = this.util.getTickersList(),
            addresses = Object.keys(this.util.getAddressesList());
        await this.indexerDb.updateBalances(addresses);
        await this.indexerDb.updateTokens(tickers);

        await this.mapper.createMappings(data);
    }

    // DELEGATE v2 — capability revoke. Removes a previously delegated signing key
    // without replacing it. Marks `deactivation_block` (BLOCK_INDEX + activation delay)
    // on the matching capability delegation row.
    async _parseCapabilityRevoke(params, data, error){

        // Extract params
        data['SIGNING_PUBKEY'] = params[1];

        if(!error)
            data = this.util.setNumberFormats(data);

        if(!error && data['COIN'] !== 'BTC')
            error = 'invalid: ACTION (BTC only)';

        // Verify SIGNING_PUBKEY is provided + format
        if(!error && this.util.isNull(data['SIGNING_PUBKEY']))
            error = 'invalid: SIGNING_PUBKEY (required)';
        if(!error && !/^[0-9a-fA-F]{64}$/.test(data['SIGNING_PUBKEY']))
            error = 'invalid: SIGNING_PUBKEY (format)';

        // Resolve the revocation target. v2 revokes either:
        //   - a previously delegated key (a `delegations` row), or
        //   - the source's ORIGINAL stake signing key — required for the
        //     key-compromise procedure to complete (a compromised stake key must
        //     be revocable once a replacement is delegated via v0). Recorded in
        //     `stake_key_revocations`; re-staking the same key later (STAKE v2)
        //     clears the revocation.
        let stakeKeyMode = false;
        if(!error){
            let activeDelegation = await this.indexerDb.getActiveDelegation(data['SOURCE'], data['SIGNING_PUBKEY'], data['BLOCK_INDEX']);
            if(!activeDelegation){
                let stakeRow = await this.indexerDb.getActiveStakeBySourceAndPubkey(data['SOURCE'], data['SIGNING_PUBKEY'], data['BLOCK_INDEX']);
                if(stakeRow){
                    let priorRevocation = await this.indexerDb.getStakeKeyRevocation(data['SOURCE'], data['SIGNING_PUBKEY'], stakeRow.action_index);
                    if(priorRevocation)
                        error = 'invalid: SIGNING_PUBKEY (already revoked)';
                    else
                        stakeKeyMode = true;
                } else {
                    error = 'invalid: no active delegation or stake key for pubkey';
                }
            }
        }

        // Verify SOURCE is not sleeping
        if(!error && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
            error = 'invalid: SOURCE (sleeping)';

        let status = (error) ? error : 'valid';
        data['STATUS'] = status;

        console.log("\t DELEGATE v2 (revoke" + (stakeKeyMode ? ', stake key' : '') + ") : pubkey=" + data['SIGNING_PUBKEY'] + ' : ' + data['STATUS']);

        let staking = this.config['STAKING'];
        let activationDelay = (staking && staking['ACTIVATION_DELAY_BLOCKS']) ? staking['ACTIVATION_DELAY_BLOCKS'] : this.config['ACTIVATION_DELAY_BLOCKS'];

        if(stakeKeyMode){
            // Stake-key revocation — recorded ONLY in stake_key_revocations. A
            // delegations record here would read as an ACTIVE delegation of the
            // revoked key and re-add it to the effective signer set.
            data['DEACTIVATION_BLOCK'] = parseInt(data['BLOCK_INDEX']) + activationDelay;
            await this.indexerDb.createStakeKeyRevocation(data);
        } else {
            // Create record in delegations table (with revoked status)
            await this.indexerDb.createRevokeDelegation(data);

            // Mark the parent delegation's deactivation_block (BLOCK_INDEX + activation delay)
            if(status === 'valid')
                await this.indexerDb.setDelegationDeactivation(data['SOURCE'], data['SIGNING_PUBKEY'], parseInt(data['BLOCK_INDEX']) + activationDelay);
        }

        // Store the SOURCE in addresses list
        this.util.addAddressTicker(data['SOURCE'], this.config['GAS']);

        let credits = [],
            debits  = [];
        await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits);

        let tickers   = this.util.getTickersList(),
            addresses = Object.keys(this.util.getAddressesList());
        await this.indexerDb.updateBalances(addresses);
        await this.indexerDb.updateTokens(tickers);

        await this.mapper.createMappings(data);
    }

    // DELEGATE v3 — contract-targeted revoke. Removes a previously delegated signing key
    // scoped to (target_contract_index, signing_pubkey, tick) without replacing it.
    // Marks `deactivation_block` on the matching contract_delegations row.
    async _parseContractRevoke(params, data, error){

        // Extract params
        data['SIGNING_PUBKEY']        = params[1];
        data['TARGET_CONTRACT_INDEX'] = params[2];
        data['TICK']                  = params[3];

        if(!error)
            data = this.util.setNumberFormats(data);

        if(!error && this.util.isNull(data['SIGNING_PUBKEY']))
            error = 'invalid: SIGNING_PUBKEY (required)';
        if(!error && !/^[0-9a-fA-F]{64}$/.test(String(data['SIGNING_PUBKEY'])))
            error = 'invalid: SIGNING_PUBKEY (format)';
        if(!error && this.util.isNull(data['TARGET_CONTRACT_INDEX']))
            error = 'invalid: TARGET_CONTRACT_INDEX (required)';
        if(!error && (!/^[0-9]+$/.test(String(data['TARGET_CONTRACT_INDEX'])) || Number(data['TARGET_CONTRACT_INDEX']) <= 0))
            error = 'invalid: TARGET_CONTRACT_INDEX (format)';
        if(!error && this.util.isNull(data['TICK']))
            error = 'invalid: TICK (required)';

        // Verify SOURCE owns an active contract_delegations row for (target, pubkey, tick)
        if(!error){
            let valid_id  = await this.indexerDb.getStatusId('valid');
            let source_id = await this.indexerDb.getAddressId(data['SOURCE']);
            let pubkey_id = await this.indexerDb.getPubkeyId(String(data['SIGNING_PUBKEY']).toLowerCase());
            let tick_id   = await this.indexerDb.getTickerId(data['TICK']);
            if(source_id === null || pubkey_id === null || tick_id === null){
                error = 'invalid: no active contract delegation';
            } else {
                let rows = await this.indexerDb.doQuery(
                    `SELECT 1 FROM contract_delegations
                     WHERE target_contract_index=? AND source_id=? AND signing_pubkey_id=? AND tick_id=?
                       AND status_id=? AND activation_block <= ?
                       AND (deactivation_block IS NULL OR deactivation_block > ?)
                     LIMIT 1`,
                    [Number(data['TARGET_CONTRACT_INDEX']), source_id, pubkey_id, tick_id, valid_id, data['BLOCK_INDEX'], data['BLOCK_INDEX']]
                );
                if(rows.length === 0)
                    error = 'invalid: no active contract delegation';
            }
        }

        if(!error && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
            error = 'invalid: SOURCE (sleeping)';

        let status = (error) ? error : 'valid';
        data['STATUS'] = status;

        console.log("\t DELEGATE v3 (contract revoke) : pubkey=" + String(data['SIGNING_PUBKEY']).substring(0,16) +
                    '... : target=' + data['TARGET_CONTRACT_INDEX'] +
                    ' : tick=' + data['TICK'] +
                    ' : ' + data['STATUS']);

        // Mark the contract_delegations row's deactivation_block
        if(status === 'valid'){
            let staking = this.config['STAKING'];
            let activationDelay = (staking && staking['ACTIVATION_DELAY_BLOCKS']) ? staking['ACTIVATION_DELAY_BLOCKS'] : this.config['ACTIVATION_DELAY_BLOCKS'];
            let deactivationBlock = parseInt(data['BLOCK_INDEX']) + activationDelay;
            let valid_id  = await this.indexerDb.getStatusId('valid');
            let pubkey_id = await this.indexerDb.getPubkeyId(String(data['SIGNING_PUBKEY']).toLowerCase());
            let tick_id   = await this.indexerDb.getTickerId(data['TICK']);
            await this.indexerDb.doQuery(
                `UPDATE contract_delegations SET deactivation_block=?
                 WHERE target_contract_index=? AND signing_pubkey_id=? AND tick_id=?
                   AND status_id=? AND deactivation_block IS NULL`,
                [deactivationBlock, Number(data['TARGET_CONTRACT_INDEX']), pubkey_id, tick_id, valid_id]
            );
        }

        this.util.addAddressTicker(data['SOURCE'], data['TICK']);

        let credits = [],
            debits  = [];
        await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits);

        let tickers   = this.util.getTickersList(),
            addresses = Object.keys(this.util.getAddressesList());
        await this.indexerDb.updateBalances(addresses);
        await this.indexerDb.updateTokens(tickers);

        await this.mapper.createMappings(data);
    }
}

module.exports = Delegate;
