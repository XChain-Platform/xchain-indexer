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
 * XChain Platform Action - CLAIM_REWARDS
 *
 * This action withdraws accrued validator rewards.
 * BTC chain only.
 *
 * PARAMS:
 * - VERSION - Format Version
 *
 * FORMATS:
 * - 0 = Withdraw accrued validator rewards
 *
 ********************************************************************/

class ClaimRewards {

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
        this.formats[0] = 'VERSION';
    }

    // Handle parsing the CLAIM_REWARDS transaction
    async parse(params, data, error){

        // Validate that format is known
        let format = data['FORMAT'];
        if(!error && (format===null || this.formats[format] === undefined ))
            error = 'invalid: VERSION (unknown)';

        // Convert NUMBER fields from string value to number value
        if(!error)
            data = this.util.setNumberFormats(data);

        /*****************************************************************
         * Chain Restriction
         ****************************************************************/

        // CLAIM_REWARDS is BTC-only
        if(!error && data['COIN'] !== 'BTC')
            error = 'invalid: ACTION (BTC only)';

        /*****************************************************************
         * Stake Existence Validations
         ****************************************************************/

        // Verify SOURCE has an active stake (any tier, gated by activation delay)
        if(!error){
            let activeStake = await this.indexerDb.getActiveStakeBySource(data['SOURCE'], null, data['BLOCK_INDEX']);
            if(!activeStake)
                error = 'invalid: no active stake';
        }

        // Verify SOURCE is not sleeping
        if(!error && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
            error = 'invalid: SOURCE (sleeping)';

        /*****************************************************************
         * Reward Calculation
         ****************************************************************/

        // Get unclaimed reward total for SOURCE
        let rewardAmount = '0';
        if(!error){
            rewardAmount = await this.indexerDb.getUnclaimedRewardTotal(data['SOURCE']);
            if(this.util.bclte(rewardAmount, '0'))
                error = 'invalid: no unclaimed rewards';
        }

        data['AMOUNT'] = rewardAmount;

        // Determine final status
        let status = (error) ? error : 'valid';
        data['STATUS'] = status;

        // Print status message
        console.log("\t CLAIM_REWARDS : amount=" + data['AMOUNT'] + ' : ' + data['STATUS']);

        // Create record in reward_claims table
        await this.indexerDb.createRewardClaim(data);

        // Store the SOURCE and GAS tick in addresses list
        let gas = this.config['GAS'];
        this.util.addAddressTicker(data['SOURCE'], gas);

        // Array of credits and debits
        let credits = [],
            debits  = [];

        // If valid, credit the reward amount to SOURCE
        if(status === 'valid'){
            credits.push([gas, rewardAmount, data['SOURCE']]);
        }

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

module.exports = ClaimRewards;
