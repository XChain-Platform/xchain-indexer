/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Platform Action - COLLECT
 *
 * This action collects accrued validator rewards.
 * BTC chain only.
 *
 * PARAMS:
 * - VERSION - Format Version
 *
 * FORMATS:
 * - 0 = Collect accrued validator rewards
 *
 ********************************************************************/

class Collect {

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

    // Handle parsing the COLLECT transaction
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

        // COLLECT is BTC-only
        if(!error && data['COIN'] !== 'BTC')
            error = 'invalid: ACTION (BTC only)';

        /*****************************************************************
         * Stake Existence Validations
         ****************************************************************/

        // Verify SOURCE has an active stake (any tier, gated by activation delay)
        if(!error){
            let activeStake = await this.indexerDb.getActiveStakeBySource(data['SOURCE'], data['BLOCK_INDEX']);
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

        // Verify the reward pool can cover this claim. Rewards are paid by debiting the
        // pre-funded REWARD address (never minted), so a claim that would overdraw the pool
        // is rejected here. Because this sets `error` before STATUS is computed below, the
        // claim is recorded as invalid and getUnclaimedRewardTotal() keeps it unclaimed —
        // the validator can COLLECT again once the pool is topped up. The balance is read at
        // (BLOCK_INDEX, ACTION_INDEX) so accept/reject is identical across all validators.
        if(!error){
            let rewardPool = this.config['ADDRESS']['REWARD'];
            let tokenInfo  = await this.indexerDb.getTokenInfo(this.config['GAS'], data['BLOCK_INDEX'], data['ACTION_INDEX']);
            let poolBal    = await this.indexerDb.getAddressBalances(rewardPool, null, data['BLOCK_INDEX'], data['ACTION_INDEX']);
            if(!tokenInfo || !this.util.hasBalance(poolBal, tokenInfo['TICK_ID'], rewardAmount))
                error = 'invalid: insufficient reward pool';
        }

        data['AMOUNT'] = rewardAmount;

        // Determine final status
        let status = (error) ? error : 'valid';
        data['STATUS'] = status;

        // Print status message
        console.log("\t COLLECT : amount=" + data['AMOUNT'] + ' : ' + data['STATUS']);

        // Create record in reward_claims table
        await this.indexerDb.createRewardClaim(data);

        // Store the SOURCE, GAS tick, and reward pool in addresses list
        let gas        = this.config['GAS'];
        let rewardPool = this.config['ADDRESS']['REWARD'];
        this.util.addAddressTicker(data['SOURCE'], gas);
        this.util.addAddressTicker(rewardPool, gas);

        // Array of credits and debits
        let credits = [],
            debits  = [];

        // If valid, pay the reward by debiting the pre-funded pool and crediting SOURCE
        // (no minting — total XCHAIN supply is unchanged by COLLECT)
        if(status === 'valid'){
            debits.push([gas, rewardAmount, rewardPool]);
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

module.exports = Collect;
