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
 * This action stakes XCHAIN tokens for hub validation.
 * BTC chain only.
 *
 * PARAMS:
 * - VERSION        - Format Version
 * - TIER           - Staking tier (1=oracle, 2=cross-chain)
 * - CHAINS         - Comma-separated chains to validate (Tier 2 only)
 * - SIGNING_PUBKEY - Ed25519 signing public key
 *
 * FORMATS:
 * - 0 = Stake XCHAIN for validation
 *
 ********************************************************************/

class Stake {

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
        this.formats[0] = 'VERSION|TIER|CHAINS|SIGNING_PUBKEY|DOGE_ADDRESS';
    }

    // Handle parsing the STAKE transaction
    async parse(params, data, error){

        // Validate that format is known
        let format = data['FORMAT'];
        if(!error && (format===null || this.formats[format] === undefined ))
            error = 'invalid: VERSION (unknown)';

        // Extract params
        data['TIER']           = params[1];
        data['CHAINS']         = params[2];
        data['SIGNING_PUBKEY'] = params[3];
        data['DOGE_ADDRESS']   = params[4];

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
         * TIER Validations
         ****************************************************************/

        // Verify TIER is valid (1=oracle, 2=cross-chain, 3=oracle publisher)
        let tier = parseInt(data['TIER']);
        if(!error && ![1, 2, 3].includes(tier))
            error = 'invalid: TIER (unknown)';

        // Verify CHAINS is provided for Tier 2
        if(!error && tier === 2 && this.util.isNull(data['CHAINS']))
            error = 'invalid: CHAINS (required for tier 2)';

        // Verify CHAINS is empty for Tier 1
        if(!error && tier === 1 && !this.util.isNull(data['CHAINS']) && data['CHAINS'] !== '')
            error = 'invalid: CHAINS (not allowed for tier 1)';

        // Verify CHAINS is empty for Tier 3 (publishers always publish to DOGE)
        if(!error && tier === 3 && !this.util.isNull(data['CHAINS']) && data['CHAINS'] !== '')
            error = 'invalid: CHAINS (not allowed for tier 3)';

        // Validate CHAINS values if provided
        if(!error && tier === 2){
            let validChains = this.config['COINS']; // ['BTC', 'LTC', 'DOGE']
            let chains = String(data['CHAINS']).split(',');
            for(let chain of chains){
                if(!validChains.includes(chain.trim()))
                    error = 'invalid: CHAINS (unknown chain)';
            }
        }

        /*****************************************************************
         * DOGE_ADDRESS Validations (Tier 3 only)
         ****************************************************************/

        // DOGE_ADDRESS is required for Tier 3
        if(!error && tier === 3 && this.util.isNull(data['DOGE_ADDRESS']))
            error = 'invalid: DOGE_ADDRESS (required for tier 3)';

        // DOGE_ADDRESS must be empty for Tier 1 and Tier 2
        if(!error && tier !== 3 && !this.util.isNull(data['DOGE_ADDRESS']) && data['DOGE_ADDRESS'] !== '')
            error = 'invalid: DOGE_ADDRESS (only allowed for tier 3)';

        // Validate DOGE_ADDRESS format (D-prefix, 34 chars base58)
        if(!error && tier === 3 && !/^D[a-km-zA-HJ-NP-Z1-9]{33}$/.test(data['DOGE_ADDRESS']))
            error = 'invalid: DOGE_ADDRESS (format)';

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
         * Balance Validations
         ****************************************************************/

        // Get XCHAIN token info and staking config
        let gas = this.config['GAS'];
        let staking = this.config['STAKING'];
        let tierConfig = (staking && staking['TIERS']) ? staking['TIERS'][tier] : null;

        // Verify staking config exists for this tier
        if(!error && !tierConfig)
            error = 'invalid: TIER (no staking config)';

        // Look up the required staking amount for this tier
        let stakeAmount = tierConfig ? tierConfig['AMOUNT'] : '0';
        data['AMOUNT'] = stakeAmount;

        // Calculate the activation block (6-block delay by default for BTC reorg safety)
        let activationDelay = (staking && staking['ACTIVATION_DELAY_BLOCKS']) ? staking['ACTIVATION_DELAY_BLOCKS'] : 6;
        data['ACTIVATION_BLOCK'] = parseInt(data['BLOCK_INDEX']) + activationDelay;

        // Get token info and source address balances
        let tokenInfo = await this.indexerDb.getTokenInfo(gas, data['BLOCK_INDEX'], data['ACTION_INDEX']);
        let balances = await this.indexerDb.getAddressBalances(data['SOURCE'], null, data['BLOCK_INDEX'], data['ACTION_INDEX']);

        // Verify SOURCE has sufficient XCHAIN balance
        if(!error && tokenInfo && !this.util.hasBalance(balances, tokenInfo['TICK_ID'], stakeAmount))
            error = 'invalid: insufficient funds (STAKE)';

        // Verify SOURCE is not sleeping
        if(!error && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
            error = 'invalid: SOURCE (sleeping)';

        // Check that the signing pubkey is not already in use by another active stake
        // Note: pubkey uniqueness is checked across ALL stakes (active or not yet activated) to prevent collision
        if(!error){
            let existingStake = await this.indexerDb.getActiveStakeByPubkey(data['SIGNING_PUBKEY']);
            if(existingStake)
                error = 'invalid: SIGNING_PUBKEY (already in use)';
        }

        // Check that SOURCE does not already have a stake at this tier (active or pending activation)
        if(!error){
            let existingStakeBySource = await this.indexerDb.getActiveStakeBySource(data['SOURCE'], tier);
            if(existingStakeBySource)
                error = 'invalid: SOURCE (already staked at this tier)';
        }

        // Determine final status
        let status = (error) ? error : 'valid';
        data['STATUS'] = status;

        // Print status message
        console.log("\t STAKE : tier=" + data['TIER'] + ' : chains=' + data['CHAINS'] + ' : ' + data['STATUS']);

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
