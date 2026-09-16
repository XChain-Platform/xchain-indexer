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
 * XChain Platform Action - AIRDROP: fees
 *
 * Prices one leg's per-tx FEE and validates how SOURCE pays it. The fees
 * object itself is created once per action by index.js.
 *
 ********************************************************************/

// Installed onto Airdrop.prototype by index.js; each method runs with `this` bound to the
// handler, exactly as the class method it was.
module.exports = {

    // Price the leg's per-tx FEE into the action's shared fees object: per-recipient gas on the
    // unified schedule once UNIFIED_FEES is enabled, the legacy database-hits model before it
    async priceAirdropLeg(recipients, fees, data){
        // Determine total transaction FEE
        let unifiedFees = await this.actions.protocolChanges.isEnabled('UNIFIED_FEES', data['BLOCK_INDEX']);
        if(unifiedFees){
            // Unified gas schedule: per-recipient gas
            let result = this.util.getUnifiedTransactionFee(recipients.size, 'AIRDROP_PER_RECIPIENT');
            fees['GAS_COST']    = result.gasCost;
            fees['AMOUNT']      = result.fee;
            fees['FEE_VERSION'] = 2;
        } else {
            // Legacy: database hits model
            let db_hits  = recipients.size * 2;
                db_hits += 3;
            fees['AMOUNT'] = this.util.getTransactionFee(db_hits, fees['TICK']);
        }
        // Emitted (VM-synthesized) actions pay no separate per-tx fee; see util.feeForAction.
        // The airdrop DEBIT to recipients is unaffected.
        fees['AMOUNT'] = this.util.feeForAction(fees['AMOUNT'], data);
    },

    // Validate fee payment (native coin or XCHAIN balance)
    async validateAirdropFeePayment(data, fees, legBalances, error){
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
                if(!this.util.hasBalance(legBalances, fees['TICK_ID'], fees['AMOUNT']))
                    error = 'invalid: insufficient funds (FEE)';
            }
        }
        return error;
    }
};
