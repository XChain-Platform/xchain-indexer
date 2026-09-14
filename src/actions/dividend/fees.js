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
 * XChain Platform Action - DIVIDEND: fees
 *
 * Prices the DIVIDEND's per-tx FEE and validates how SOURCE pays it. The
 * fees object itself is created by index.js.
 *
 ********************************************************************/

// Installed onto Dividend.prototype by index.js; each method runs with `this` bound to the
// handler, exactly as the class method it was.
module.exports = {

    // Price the per-tx FEE into the fees object: per-recipient gas on the unified schedule once
    // UNIFIED_FEES is enabled, the legacy database-hits model before it
    async priceDividend(recipients, fees, data){
        // Determine total transaction FEE
        let unifiedFees = await this.actions.protocolChanges.isEnabled('UNIFIED_FEES', data['BLOCK_INDEX']);
        if(unifiedFees){
            // Unified gas schedule: per-recipient gas
            let recipientCount = (recipients) ? Object.keys(recipients).length : 0;
            let result = this.util.getUnifiedTransactionFee(recipientCount, 'DIVIDEND_PER_RECIPIENT');
            fees['GAS_COST']    = result.gasCost;
            fees['AMOUNT']      = result.fee;
            fees['FEE_VERSION'] = 2;
        } else {
            // Legacy: database hits model. LEGACY_FEE_NUMERIC_DBHITS gates the fix of
            // the db_hits string-concatenation bug: below the flag-day reproduce the original
            // `db_hits += bcmul(...)` concatenation byte-for-byte (3 + "4" -> "34") so a
            // pre-activation replay commits the identical (inflated) fee; at/above it accumulate
            // numerically. See protocol_changes.js.
            let numericDbHits = await this.actions.protocolChanges.isEnabled('LEGACY_FEE_NUMERIC_DBHITS', data['BLOCK_INDEX']);
            let db_hits = 3;
            if(numericDbHits)
                db_hits += (recipients) ? Number(Object.keys(recipients).length) * 2 : 0;
            else
                db_hits += (recipients) ? this.util.bcmul(Object.keys(recipients).length, 2, 0) : 0;
            fees['AMOUNT'] = this.util.getTransactionFee(db_hits, fees['TICK']);
        }
        // Emitted (VM-synthesized) actions pay no separate per-tx fee; see util.feeForAction
        // (the dividend DEBIT to holders is unaffected).
        fees['AMOUNT'] = this.util.feeForAction(fees['AMOUNT'], data);
    },

    // Validate fee payment (native coin or XCHAIN balance)
    async validateDividendFeePayment(data, fees, balances, error){
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
        return error;
    }
};
