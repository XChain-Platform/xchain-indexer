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
 * COLLECT validation: who may collect (BTC chain, an active stake, not sleeping)
 * and how much (the unclaimed total earned up to this block, an optional partial
 * AMOUNT behind PARTIAL_UNSTAKE_COLLECT, and a reward pool that can cover it).
 * Each check only runs while no earlier one has failed.
 *
 ********************************************************************/

// Installed onto Collect.prototype by collect.js; each method runs with `this` bound to
// the handler, exactly as the class method it was.
module.exports = {

    // Chain restriction and stake existence. Returns the error the handler carries forward.
    async validateCollector(data, error){

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

        return error;
    },

    // Reward calculation, the optional partial AMOUNT and the pool's cover for the claim.
    // Returns { error, rewardAmount } for the handler to carry forward.
    async validateRewardClaim(params, data, error){

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

        return { error, rewardAmount };
    }
};
