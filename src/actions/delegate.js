/*********************************************************************
 *
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 *
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided "AS IS", without warranties or conditions of any kind.
 *
 **********************************************************************
 *
 * XChain Platform Action - DELEGATE
 *
 * This action rotates the signing key for a staked validator.
 * BTC chain only.
 *
 * PARAMS:
 * - VERSION            - Format Version
 * - NEW_SIGNING_PUBKEY - New Ed25519 signing public key
 *
 * FORMATS:
 * - 0 = Rotate signing key
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
        this.formats[0] = 'VERSION|NEW_SIGNING_PUBKEY';
    }

    // Handle parsing the DELEGATE transaction
    async parse(params, data, error){

        // Validate that format is known
        let format = data['FORMAT'];
        if(!error && (format===null || this.formats[format] === undefined ))
            error = 'invalid: VERSION (unknown)';

        // Extract params
        data['SIGNING_PUBKEY'] = params[1];

        // Convert NUMBER fields from string value to number value
        if(!error)
            data = this.util.setNumberFormats(data);

        /*****************************************************************
         * Chain Restriction
         ****************************************************************/

        // DELEGATE is BTC-only
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

        // Verify SOURCE is not sleeping
        if(!error && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
            error = 'invalid: SOURCE (sleeping)';

        // Calculate the activation block (6-block delay for BTC reorg safety)
        let staking = this.config['STAKING'];
        let activationDelay = (staking && staking['ACTIVATION_DELAY_BLOCKS']) ? staking['ACTIVATION_DELAY_BLOCKS'] : 6;
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
}

module.exports = Delegate;
