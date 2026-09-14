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
 * ORDER fees: the amount a create or edit owes for its expiration and
 * any ownership escrow, then the check that SOURCE can pay it (a native
 * coin output or an XCHAIN balance) and the balance debit that follows.
 *
 ********************************************************************/

// Price the order: the expiration fee plus, on a create that escrows ownership, the
// ownership-escrow premium. Cancels are free.
async function priceOrder(handler, st){
    let { format, data, error, orderInfo, isOwnershipGive, fees } = st;

    // Calculate total fee for this order: expiration + ownership-escrow premium (create only)
    fees['AMOUNT'] = 0;

    // Calculate the fee for this order, based on its expiration and any ownership escrow
    if(!error && (format==0 || format==2)){
        let unifiedFees = await handler.actions.protocolChanges.isEnabled('UNIFIED_FEES', data['BLOCK_INDEX']);
        if(unifiedFees){
            let gasCost = 0;
            let fee     = 0;
            if(!handler.util.isNull(data['EXPIRATION'])){
                let exp = handler.util.getUnifiedExpirationFee(data, orderInfo);
                gasCost = handler.util.bcadd(gasCost, exp.gasCost, 0);
                fee     = handler.util.bcadd(fee, exp.fee, 8);
            }
            if(format==0 && isOwnershipGive){
                let own = handler.util.getOwnershipEscrowFee();
                gasCost = handler.util.bcadd(gasCost, own.gasCost, 0);
                fee     = handler.util.bcadd(fee, own.fee, 8);
            }
            fees['GAS_COST']    = gasCost;
            fees['AMOUNT']      = fee;
            fees['FEE_VERSION'] = 2;
        } else if(!handler.util.isNull(data['EXPIRATION'])){
            fees['AMOUNT'] = handler.util.getExpirationFee(data, orderInfo);
        }
    }
}

// Check SOURCE can pay the fee, by a native coin output or from its XCHAIN balance, then
// take an XCHAIN-paid fee out of the balances.
async function validateFeePayment(handler, st){
    let { data, fees } = st;
    let error    = st.error;
    let balances = st.balances;

    // Validate fee payment (native coin or XCHAIN balance)
    if(!error && handler.util.bcgt(fees['AMOUNT'], 0)){
        let paymentMode = handler.util.detectFeePaymentMode(data, handler.decoderDb, data['TX_OUTPUTS']);
        if(paymentMode === 'native'){
            let validation = await handler.util.validateNativeCoinFee(data, fees, handler.indexerDb, data['TX_OUTPUTS']);
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
            if(!handler.util.hasBalance(balances, fees['TICK_ID'], fees['AMOUNT']))
                error = 'invalid: insufficient funds (FEE)';
        }
    }

    // Adjust balances to reduce by FEE AMOUNT (only for XCHAIN deduction mode)
    if(!error && (!fees['PAYMENT_MODE'] || fees['PAYMENT_MODE'] === 2))
        balances = handler.util.debitBalances(balances, fees['TICK_ID'], fees['AMOUNT']);

    st.error    = error;
    st.balances = balances;
}

module.exports = { priceOrder, validateFeePayment };
