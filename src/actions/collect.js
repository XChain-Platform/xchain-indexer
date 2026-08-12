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
 * XChain Platform Action - COLLECT
 *
 * This action collects accrued validator rewards.
 * BTC chain only.
 *
 * PARAMS:
 * - VERSION - Format Version
 * - AMOUNT  - OPTIONAL trailing partial-claim amount, gated by
 *             PARTIAL_UNSTAKE_COLLECT: absent = claim the full unclaimed
 *             total (the historical behavior, byte-identical); present =
 *             claim only AMOUNT, the remainder stays pending. Below the
 *             flag-day a present AMOUNT is ignored (a legacy node cannot
 *             see it, so ignoring is the only pre-activation rule the
 *             whole fleet agrees on).
 *
 * FORMATS:
 * - 0 = Collect accrued validator rewards
 *
 ********************************************************************/

class Collect {

    constructor(action){
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;

        this.formats = {};
        this.formats[0] = 'VERSION|AMOUNT';    // AMOUNT optional (partial claim)
    }

    async parse(params, data, error){

        let format = data['FORMAT'];
        if(!error && (format===null || this.formats[format] === undefined ))
            error = 'invalid: VERSION (unknown)';

        if(!error)
            data = this.util.setNumberFormats(data);

        /*****************************************************************
         * Chain Restriction
         ****************************************************************/

        if(!error && data['COIN'] !== 'BTC')
            error = 'invalid: ACTION (BTC only)';

        /*****************************************************************
         * Stake Existence Validations
         ****************************************************************/

        // Any tier, gated by activation delay
        if(!error){
            let activeStake = await this.indexerDb.getActiveStakeBySource(data['SOURCE'], data['BLOCK_INDEX']);
            if(!activeStake)
                error = 'invalid: no active stake';
        }

        if(!error && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
            error = 'invalid: SOURCE (sleeping)';

        /*****************************************************************
         * Reward Calculation
         ****************************************************************/

        // Get unclaimed reward total for SOURCE, scoped to rewards earned at or
        // before this COLLECT's block. The scope makes the claim replayable: on a
        // reindex (or ANCHOR full-parse recovery, which bulk-restores pushed
        // reward rows) this COLLECT must see exactly the rewards that were
        // visible when it confirmed, not rewards earned later (CONSENSUS).
        let rewardAmount = '0';
        if(!error){
            rewardAmount = await this.indexerDb.getUnclaimedRewardTotal(data['SOURCE'], data['BLOCK_INDEX']);
            if(this.util.bclte(rewardAmount, '0'))
                error = 'invalid: no unclaimed rewards';
        }

        // Optional partial AMOUNT, gated by PARTIAL_UNSTAKE_COLLECT. A
        // present-but-full amount falls through untouched so the resulting state is
        // byte-identical to the absent form. Over-ask and malformed amounts REJECT
        // (never clamp). Below the flag-day the field is never read, preserving the
        // legacy ignore-extra-params behavior exactly.
        if(!error && params.length > 1 && await this.actions.protocolChanges.isEnabled('PARTIAL_UNSTAKE_COLLECT', data['BLOCK_INDEX'])){
            let amountStr = String(params[1]);
            if(!/^[0-9]+(\.[0-9]{1,8})?$/.test(amountStr))
                error = 'invalid: AMOUNT (format)';
            else if(!this.util.bcgt(amountStr, '0'))
                error = 'invalid: AMOUNT (must be greater than 0)';
            else if(this.util.bcgt(amountStr, rewardAmount))
                error = 'invalid: AMOUNT (exceeds unclaimed rewards)';
            else if(this.util.bclt(amountStr, rewardAmount))
                rewardAmount = this.util.bcformat(amountStr, 8);
        }

        // Verify the reward pool can cover this claim. Rewards are paid by debiting the
        // pre-funded REWARD address (never minted), so a claim that would overdraw the pool
        // is rejected here. Because this sets `error` before STATUS is computed below, the
        // claim is recorded as invalid and getUnclaimedRewardTotal() keeps it unclaimed.
        // The validator can COLLECT again once the pool is topped up. The balance is read at
        // (BLOCK_INDEX, ACTION_INDEX) so accept/reject is identical across all validators.
        if(!error){
            let rewardPool = this.config['ADDRESS']['REWARD'];
            let tokenInfo  = await this.indexerDb.getTokenInfo(this.config['GAS'], data['BLOCK_INDEX'], data['ACTION_INDEX']);
            let poolBal    = await this.indexerDb.getAddressBalances(rewardPool, null, data['BLOCK_INDEX'], data['ACTION_INDEX']);
            if(!tokenInfo || !this.util.hasBalance(poolBal, tokenInfo['TICK_ID'], rewardAmount))
                error = 'invalid: insufficient reward pool';
        }

        data['AMOUNT'] = rewardAmount;

        let status = (error) ? error : 'valid';
        data['STATUS'] = status;

        console.log("\t COLLECT : amount=" + data['AMOUNT'] + ' : ' + data['STATUS']);

        await this.indexerDb.createRewardClaim(data);

        let gas        = this.config['GAS'];
        let rewardPool = this.config['ADDRESS']['REWARD'];
        this.util.addAddressTicker(data['SOURCE'], gas);
        this.util.addAddressTicker(rewardPool, gas);

        let credits = [],
            debits  = [];

        // Pay the reward by debiting the pre-funded pool and crediting SOURCE
        // (no minting; total XCHAIN supply is unchanged by COLLECT)
        if(status === 'valid'){
            debits.push([gas, rewardAmount, rewardPool]);
            credits.push([gas, rewardAmount, data['SOURCE']]);
        }

        await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits);

        let tickers   = this.util.getTickersList(),
            addresses = Object.keys(this.util.getAddressesList());

        await this.indexerDb.updateBalances(addresses);
        await this.indexerDb.updateTokens(tickers);

        await this.mapper.createMappings(data);
    }
}

module.exports = Collect;
