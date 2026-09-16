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
 * BET fees: the unified schedule each format charges, and the check that SOURCE
 * can pay it (native coin or XCHAIN balance) with the stake itself still covered
 * once the fee comes off. Why cancel and resolve are free is on applyFees.
 *
 ********************************************************************/

// Installed onto Bet.prototype by bet.js; each method runs with `this` bound to the
// handler, exactly as the class method it was.
module.exports = {

    // Fee schedule and fee payment for this format
    async applyFees(data, format, fees, balances, feedTokenInfo, error){

        // Fees: unified schedule only. BET and UNIFIED_FEES are both genesis-active on every
        // chain and network, so a BET action can never process below the gate; the legacy
        // else-branch other actions carry would be dead code here, and dead code that
        // silently charges zero if the condition were ever mis-evaluated.
        fees['AMOUNT'] = 0;

        // Create: duration-metered on the feed's full pass-eligible life
        // (expire_at - BLOCK_TIME), the ORDER/DISPENSER expiration mechanism
        // with its own schedule key (spec decision F). Short feeds inside the
        // shared free window create for nothing
        if(!error && format==0){
            let duration = this.util.getUnifiedDurationFee(data['EXPIRE_AT'], data['BLOCK_TIME'], 'BET_FEED_PER_DAY');
            fees['GAS_COST']    = duration.gasCost;
            fees['AMOUNT']      = duration.fee;
            fees['FEE_VERSION'] = 2;
        }

        // Place: one terminal credit pre-funded (AIRDROP per-recipient parity).
        // This is what makes the free system-injected expiry pass sound: every
        // refund credit BET_EXPIRE emits was paid for here
        if(!error && format==2){
            let credit = this.util.getUnifiedTransactionFee(1, 'BET_PER_CREDIT');
            fees['GAS_COST']    = credit.gasCost;
            fees['AMOUNT']      = credit.fee;
            fees['FEE_VERSION'] = 2;
        }

        // Cancel and resolve are FREE (decision F): every credit they emit is
        // pre-funded at place time, and a resolve surcharge would be griefable
        // (dust bets inflating the oracle's cost until rational expiry)

        return error;
    },

    // Validate fee payment (native coin or XCHAIN balance), then check the stake itself
    async validateFeePayment(data, format, fees, balances, feedTokenInfo, error){
        if(!error && this.util.bcgt(fees['AMOUNT'], 0)){
            let paymentMode = this.util.detectFeePaymentMode(data, this.decoderDb, data['TX_OUTPUTS']);
            if(paymentMode === 'native'){
                let validation = await this.util.validateNativeCoinFee(data, fees, this.indexerDb, data['TX_OUTPUTS']);
                if(!validation.valid){
                    error = 'invalid: ' + (validation.error || 'native coin fee validation failed');
                } else {
                    fees['PAYMENT_MODE']       = 1;
                    fees['NATIVE_COIN_AMOUNT'] = validation.nativeCoinAmount;
                    fees['NATIVE_COIN']        = validation.nativeCoin;
                    fees['ORACLE_ROUND']       = validation.oracleRound;
                }
            } else if(paymentMode === 'rejected'){
                error = 'invalid: insufficient fee (native coin output required)';
            } else {
                if(!this.util.hasBalance(balances, fees['TICK_ID'], fees['AMOUNT']))
                    error = 'invalid: insufficient funds (FEE)';
            }
        }

        // Adjust balances to reduce by FEE AMOUNT (only for XCHAIN deduction mode)
        if(!error && (!fees['PAYMENT_MODE'] || fees['PAYMENT_MODE'] === 2))
            balances = this.util.debitBalances(balances, fees['TICK_ID'], fees['AMOUNT']);

        // Verify SOURCE has enough balance to cover the stake (place, after fee deduction)
        if(!error && format==2 && !this.util.hasBalance(balances, feedTokenInfo['TICK_ID'], data['AMOUNT']))
            error = 'invalid: insufficient funds (AMOUNT)';

        return error;
    }
};
