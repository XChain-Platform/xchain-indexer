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
 * XChain Platform Action - REVOKE_DELEGATION
 *
 * This action revokes a previously delegated signing key.
 * BTC chain only.
 *
 * PARAMS:
 * - VERSION        - Format Version
 * - SIGNING_PUBKEY - Ed25519 signing public key to revoke
 *
 * FORMATS:
 * - 0 = Revoke a signing key
 *
 ********************************************************************/

class RevokeDelegation {

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
        this.formats[0] = 'VERSION|SIGNING_PUBKEY';
    }

    // Handle parsing the REVOKE_DELEGATION transaction
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

        // REVOKE_DELEGATION is BTC-only
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
         * Delegation Existence Validations
         ****************************************************************/

        // Verify SOURCE has an active delegation for this pubkey
        if(!error){
            let activeDelegation = await this.indexerDb.getActiveDelegation(data['SOURCE'], data['SIGNING_PUBKEY']);
            if(!activeDelegation)
                error = 'invalid: no active delegation for pubkey';
        }

        // Verify SOURCE is not sleeping
        if(!error && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
            error = 'invalid: SOURCE (sleeping)';

        // Determine final status
        let status = (error) ? error : 'valid';
        data['STATUS'] = status;

        // Print status message
        console.log("\t REVOKE_DELEGATION : pubkey=" + data['SIGNING_PUBKEY'] + ' : ' + data['STATUS']);

        // Create record in delegations table (with revoked status)
        await this.indexerDb.createRevokeDelegation(data);

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

module.exports = RevokeDelegation;
