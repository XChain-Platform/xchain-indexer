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
 * DISPENSER handler part: FEE PRICING AND PAYMENT.
 *
 * The expiration and ownership-escrow premium, under the UNIFIED_FEES gate and the
 * legacy path below it, and the native-coin / XCHAIN payment validation that
 * follows. Moved whole out of parse().
 *
 ********************************************************************/

'use strict';

// Installed onto Dispenser.prototype by dispenser.js; each method runs with `this`
// bound to the handler, exactly as the inline code it was.
module.exports = {

    // Sizes fees['AMOUNT'] and validates its payment; debits `balances` in the
    // XCHAIN deduction mode.
    async priceDispenserFees(ctx){
    let { data, error, format, isOwnershipGive, dispenserInfo, balances, fees } = ctx;

        // Calculate total fee for this dispenser (expiration + ownership-escrow premium, create only)
        fees['AMOUNT'] = 0;

        // Only work out the fee while the dispenser is still valid
        if(!error){
            let unifiedFees = await this.actions.protocolChanges.isEnabled('UNIFIED_FEES', data['BLOCK_INDEX']);
            if(unifiedFees){
                let gasCost = 0;
                let fee     = 0;
                if(!this.util.isNull(data['EXPIRATION'])){
                    let exp = this.util.getUnifiedExpirationFee(data, dispenserInfo);
                    gasCost = this.util.bcadd(gasCost, exp.gasCost, 0);
                    fee     = this.util.bcadd(fee, exp.fee, 8);
                }
                if(format==0 && isOwnershipGive){
                    let own = this.util.getOwnershipEscrowFee();
                    gasCost = this.util.bcadd(gasCost, own.gasCost, 0);
                    fee     = this.util.bcadd(fee, own.fee, 8);
                }
                fees['GAS_COST']    = gasCost;
                fees['AMOUNT']      = fee;
                fees['FEE_VERSION'] = 2;
            } else if(!this.util.isNull(data['EXPIRATION'])){
                fees['AMOUNT'] = this.util.getExpirationFee(data, dispenserInfo);
            }
        }

        // Validate fee payment (native coin or XCHAIN balance)
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

    ctx.data = data;
    ctx.error = error;
    ctx.balances = balances;
    ctx.fees = fees;
    },
};

