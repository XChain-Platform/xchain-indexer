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
 * XChain Platform Action - STAKE
 *
 * Stakes XCHAIN tokens for hub validation. BTC chain only.
 *
 * The protocol does not assign tiers. Capabilities (price, cross_chain,
 * oracle_publish, attestation) auto-qualify when stake amount meets the
 * governance-configured min_stake for each. See:
 *   claude/reports/specs/2026-05-24_capability-staking-model.md
 *
 * FORMATS:
 *   v1 - VERSION|AMOUNT|SIGNING_PUBKEY            (create new stake)
 *   v2 - VERSION|AMOUNT|SIGNING_PUBKEY            (top-up existing stake)
 *
 * Top-ups create their own stake row with version=2. Active stake amount
 * for a pubkey is the SUM of all active stake rows for that pubkey.
 *
 ********************************************************************/

class Stake {

    // Handle constructing a class instance
    constructor(action){
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;

        // Define list of known FORMATS
        this.formats = {};
        this.formats[1] = 'VERSION|AMOUNT|SIGNING_PUBKEY';   // create new stake
        this.formats[2] = 'VERSION|AMOUNT|SIGNING_PUBKEY';   // top-up existing stake
    }

    // Handle parsing the STAKE transaction
    async parse(params, data, error){

        // Validate that format is known
        let format = data['FORMAT'];
        if(!error && (format===null || this.formats[format] === undefined))
            error = 'invalid: VERSION (unknown)';

        // Extract params
        data['AMOUNT']         = params[1];
        data['SIGNING_PUBKEY'] = params[2];

        // Convert NUMBER fields from string value to number value
        if(!error)
            data = this.util.setNumberFormats(data);

        /*****************************************************************
         * Chain Restriction
         ****************************************************************/

        // STAKE is BTC-only
        if(!error && data['COIN'] !== 'BTC')
            error = 'invalid: ACTION (BTC only)';

        /*****************************************************************
         * AMOUNT Validations
         ****************************************************************/

        // AMOUNT must be a positive 8-decimal string
        if(!error && (this.util.isNull(data['AMOUNT']) || !/^[0-9]+(\.[0-9]{1,8})?$/.test(String(data['AMOUNT']))))
            error = 'invalid: AMOUNT (format)';
        if(!error && !this.util.bcgt(data['AMOUNT'], '0'))
            error = 'invalid: AMOUNT (must be greater than 0)';

        /*****************************************************************
         * SIGNING_PUBKEY Validations
         ****************************************************************/

        // Verify SIGNING_PUBKEY is provided
        if(!error && this.util.isNull(data['SIGNING_PUBKEY']))
            error = 'invalid: SIGNING_PUBKEY (required)';

        // Verify SIGNING_PUBKEY is 64 hex characters (Ed25519)
        if(!error && !/^[0-9a-fA-F]{64}$/.test(String(data['SIGNING_PUBKEY'])))
            error = 'invalid: SIGNING_PUBKEY (format)';

        /*****************************************************************
         * Format-Specific Stake Validation
         ****************************************************************/

        let existingStake = null;
        if(!error){
            existingStake = await this.indexerDb.getActiveStakeByPubkey(
                data['SIGNING_PUBKEY'], data['BLOCK_INDEX']
            );
        }

        if(!error && format === 1){
            // v1 (new stake): pubkey must NOT already have an active stake
            if(existingStake)
                error = 'invalid: SIGNING_PUBKEY (already in use)';
        }

        if(!error && format === 2){
            // v2 (top-up): pubkey MUST have an active stake owned by SOURCE
            if(!existingStake){
                error = 'invalid: SIGNING_PUBKEY (no active stake to top up)';
            } else {
                let sourceId = await this.indexerDb.getAddressId(data['SOURCE']);
                if(sourceId === null || sourceId !== existingStake.source_id)
                    error = 'invalid: SOURCE (does not own this stake)';
            }
        }

        /*****************************************************************
         * Balance Validations
         ****************************************************************/

        let gas = this.config['GAS'];
        let tokenInfo = await this.indexerDb.getTokenInfo(gas, data['BLOCK_INDEX'], data['ACTION_INDEX']);
        let balances  = await this.indexerDb.getAddressBalances(data['SOURCE'], null, data['BLOCK_INDEX'], data['ACTION_INDEX']);

        // Verify SOURCE has sufficient XCHAIN balance for AMOUNT
        if(!error && tokenInfo && !this.util.hasBalance(balances, tokenInfo['TICK_ID'], data['AMOUNT']))
            error = 'invalid: insufficient funds (STAKE)';

        // Verify SOURCE is not sleeping
        if(!error && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
            error = 'invalid: SOURCE (sleeping)';

        /*****************************************************************
         * Activation Calculation
         ****************************************************************/

        let staking = this.config['STAKING'];
        let activationDelay = (staking && staking['ACTIVATION_DELAY_BLOCKS']) ? staking['ACTIVATION_DELAY_BLOCKS'] : 6;
        data['ACTIVATION_BLOCK'] = parseInt(data['BLOCK_INDEX']) + activationDelay;
        data['VERSION'] = format;

        // Determine final status
        let status = (error) ? error : 'valid';
        data['STATUS'] = status;

        // Print status message
        let label = (format === 2) ? 'STAKE topup' : 'STAKE';
        console.log("\t " + label + " : amount=" + data['AMOUNT'] + ' : pubkey=' + String(data['SIGNING_PUBKEY']).substring(0, 16) + '... : ' + data['STATUS']);

        // Create record in stakes table
        await this.indexerDb.createStake(data);

        // Store the SOURCE and GAS tick in addresses list
        this.util.addAddressTicker(data['SOURCE'], gas);

        // Array of credits and debits
        let credits = [],
            debits  = [];

        // If valid, debit the stake amount from SOURCE
        if(status == 'valid')
            debits.push([gas, data['AMOUNT'], data['SOURCE']]);

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

module.exports = Stake;
