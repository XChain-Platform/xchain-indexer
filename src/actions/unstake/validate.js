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
 * UNSTAKE wire-field validation: the signing pubkey both flavors name, the
 * (TARGET_CONTRACT_INDEX, TICK) target the contract flavor names, the optional
 * partial AMOUNT each flavor reads under PARTIAL_UNSTAKE_COLLECT, and the
 * per-chain activation delay both flavors add to BLOCK_INDEX.
 *
 ********************************************************************/

// Installed onto Unstake.prototype by unstake.js; each method runs with `this` bound to
// the handler, exactly as the class code it came from.
module.exports = {

    // Verify SIGNING_PUBKEY is provided (it names the stake being unwound)
    // and is 64 hex characters (Ed25519)
    validateSigningPubkey(data, error){
        if(!error && this.util.isNull(data['SIGNING_PUBKEY']))
            error = 'invalid: SIGNING_PUBKEY (required)';
        if(!error && !/^[0-9a-fA-F]{64}$/.test(String(data['SIGNING_PUBKEY'])))
            error = 'invalid: SIGNING_PUBKEY (format)';
        return error;
    },

    // Verify the contract-targeted fields (v1): TARGET_CONTRACT_INDEX, then TICK
    async validateContractTarget(data, error){
        // Verify TARGET_CONTRACT_INDEX is provided (a v1 unstake is scoped to one contract)
        if(!error && this.util.isNull(data['TARGET_CONTRACT_INDEX']))
            error = 'invalid: TARGET_CONTRACT_INDEX (required)';
        // Gated by CONTRACT_INDEX_CANONICAL: reject non-canonical leading zeros at/after the flag-day.
        let idxRe = (await this.actions.protocolChanges.isEnabled('CONTRACT_INDEX_CANONICAL', data['BLOCK_INDEX'])) ? /^[1-9]\d*$/ : /^[0-9]+$/;
        if(!error && (!idxRe.test(String(data['TARGET_CONTRACT_INDEX'])) || Number(data['TARGET_CONTRACT_INDEX']) <= 0))
            error = 'invalid: TARGET_CONTRACT_INDEX (format)';
        // Verify TICK is provided (one contract can hold stakes in several tokens, so the unstake must say which)
        if(!error && this.util.isNull(data['TICK']))
            error = 'invalid: TICK (required)';
        return error;
    },

    // The v0 partial AMOUNT (params[2]): at most 8 decimals, above zero, no larger than
    // the active stake. requestedAmount stays null for an absent or full AMOUNT.
    async readCapabilityPartialAmount(params, data, error, totalAmount){
        let requestedAmount = null;
        if(!error && params.length > 2 && await this.actions.protocolChanges.isEnabled('PARTIAL_UNSTAKE_COLLECT', data['BLOCK_INDEX'])){
            let amountStr = String(params[2]);
            if(!/^[0-9]+(\.[0-9]{1,8})?$/.test(amountStr))
                error = 'invalid: AMOUNT (format)';
            else if(!this.util.bcgt(amountStr, '0'))
                error = 'invalid: AMOUNT (must be greater than 0)';
            else if(this.util.bcgt(amountStr, totalAmount))
                error = 'invalid: AMOUNT (exceeds active stake)';
            else if(this.util.bclt(amountStr, totalAmount))
                requestedAmount = this.util.bcformat(amountStr, 8);
        }
        return { error, requestedAmount };
    },

    // The v1 partial AMOUNT (params[4]): precision bounded by the staked TICK's DECIMALS
    // (8 when the token carries none), above zero, no larger than the active stake.
    // requestedAmount stays null for an absent or full AMOUNT.
    async readContractPartialAmount(params, data, error, totalAmount){
        let requestedAmount = null;
        let tickDecimals    = 8;
        if(!error && params.length > 4 && await this.actions.protocolChanges.isEnabled('PARTIAL_UNSTAKE_COLLECT', data['BLOCK_INDEX'])){
            let amountStr = String(params[4]);
            let tickTokenInfo = await this.indexerDb.getTokenInfo(data['TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX']);
            if(tickTokenInfo && tickTokenInfo['DECIMALS'] !== undefined && tickTokenInfo['DECIMALS'] !== null)
                tickDecimals = Number(tickTokenInfo['DECIMALS']);
            if(!/^[0-9]+(\.[0-9]+)?$/.test(amountStr)){
                error = 'invalid: AMOUNT (format)';
            } else {
                let parts = amountStr.split('.');
                let fracDigits = parts.length > 1 ? parts[1].replace(/0+$/, '').length : 0;
                if(fracDigits > tickDecimals)
                    error = 'invalid: AMOUNT (exceeds token decimals)';
            }
            if(!error && !this.util.bcgt(amountStr, '0'))
                error = 'invalid: AMOUNT (must be greater than 0)';
            // Verify AMOUNT is no larger than what is actually staked (an over-ask is rejected, never trimmed to fit)
            if(!error && this.util.bcgt(amountStr, totalAmount))
                error = 'invalid: AMOUNT (exceeds active stake)';
            // An AMOUNT below the staked total is a partial unstake; asking for the exact total stays a full sweep
            if(!error && this.util.bclt(amountStr, totalAmount))
                requestedAmount = this.util.bcformat(amountStr, tickDecimals);
        }
        return { error, requestedAmount, tickDecimals };
    },

    // The chain's activation delay: STAKING.ACTIVATION_DELAY_BLOCKS when set, else the
    // top-level ACTIVATION_DELAY_BLOCKS
    activationDelay(){
        let staking = this.config['STAKING'];
        return (staking && staking['ACTIVATION_DELAY_BLOCKS']) ? staking['ACTIVATION_DELAY_BLOCKS'] : this.config['ACTIVATION_DELAY_BLOCKS'];
    }
};
