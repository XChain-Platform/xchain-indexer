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
 * XChain Platform Action - CALLBACK : validation
 *
 * The TICK, ACTION and FORMAT checks, the general checks (sleeping parties, the
 * callback block, the MEMO) and the funding checks a CALLBACK passes before its
 * ledger is written. Each takes the error so far and returns it. Called with the
 * CALLBACK handler as `this` (see ../callback.js).
 *
 ********************************************************************/

'use strict';

// The TICK, ACTION and FORMAT validations.
async function validateCallbackToken(data, tokenInfo, callbackTokenInfo, error){
    /*****************************************************************
     * TICK Validations
     ****************************************************************/

    // Validate TICK exists
    if(!error && !tokenInfo)
        error = 'invalid: TICK (unknown)';

    // Validate CALLBACK_TICK exists
    if(!error && !callbackTokenInfo)
        error = 'invalid: CALLBACK_TICK (unknown)';

    /*****************************************************************
     * ACTION Validations
     ****************************************************************/

    // Verify CALLBACK is allowed
    if(!error && !this.util.isNull(tokenInfo['LOCK_CALLBACK']) && tokenInfo['LOCK_CALLBACK']==1)
        error = "invalid: LOCK_CALLBACK";

    // Verify only token OWNER can perform CALLBACK action
    if(!error && data['SOURCE']!=tokenInfo['OWNER'])
        error = "invalid: SOURCE (not authorized)";

    // Reject if TICK ownership is currently escrowed by an open ORDER/SWAP/DISPENSER
    if(!error && await this.indexerDb.isOwnershipEscrowed(data['TICK']))
        error = "invalid: TICK (ownership escrowed)";

    /*****************************************************************
     * FORMAT Validations
     ****************************************************************/

    // Verify CALLBACK_BLOCK format
    if(!error && tokenInfo && !this.util.isNull(tokenInfo['CALLBACK_BLOCK']) && tokenInfo['CALLBACK_BLOCK'] != parseInt(tokenInfo['CALLBACK_BLOCK']))
        error = 'invalid: CALLBACK_BLOCK (format)';

    // Verify CALLBACK_AMOUNT format
    if(!error && tokenInfo && !this.util.isNull(tokenInfo['CALLBACK_AMOUNT']) && !this.util.isValidAmountFormat(callbackTokenInfo['DECIMALS'], tokenInfo['CALLBACK_AMOUNT'], data['BLOCK_TIME']))
        error = 'invalid: CALLBACK_AMOUNT (format)';

    return error;
}

// The general validations: sleeping parties, the callback block and the MEMO.
async function validateCallbackState(data, tokenInfo, error){
    /*****************************************************************
     * General Validations
     ****************************************************************/

    // Verify SOURCE is not sleeping
    if(!error && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
        error = 'invalid: SOURCE (sleeping)';

    // Verify TICK is not sleeping
    if(!error && await this.indexerDb.isActionAllowed(null, tokenInfo['TICK'], data['BLOCK_INDEX']) == false)
        error = 'invalid: TICK (sleeping)';

    // Verify CALLBACK_TICK is not sleeping
    if(!error && await this.indexerDb.isActionAllowed(null, tokenInfo['CALLBACK_TICK'], data['BLOCK_INDEX']) == false)
        error = 'invalid: CALLBACK_TICK (sleeping)';

    // Verify CALLBACK_BLOCK is less than or equal to current block index
    if(!error && tokenInfo && !this.util.isNull(tokenInfo['CALLBACK_BLOCK']) && tokenInfo['CALLBACK_BLOCK'] > data['BLOCK_INDEX'])
        error = 'invalid: CALLBACK_BLOCK (block index)';

    // MEMO cannot contain '|' (field delimiter) or ';' (action delimiter)
    if(!error && !this.util.isNull(data['MEMO']) && String(data['MEMO']).indexOf('|')!=-1)
        error = 'invalid: MEMO (pipe)';

    // Verify no semicolon in MEMO (semicolon is action delimiter)
    if(!error && !this.util.isNull(data['MEMO']) && String(data['MEMO']).indexOf(';')!=-1)
        error = 'invalid: MEMO (semicolon)';

    // Verify MEMO is shorter than MAX_MEMO_LENGTH
    if(!error && String(data['MEMO']).length > this.config['MAX_MEMO_LENGTH'])
        error = 'invalid: MEMO (length)';

    return error;
}

// Funding: the CALLBACK_TICK owed and the fee, each debited from the working balances so
// the next check sees what the previous one spent. The debited balances go back on state.
async function validateCallbackFunding(data, s, error, totalCallbackTickAmount){
    let balances = s.balances, callbackTokenInfo = s.callbackTokenInfo, fees = s.fees;
    // Verify SOURCE has enough balances to cover CALLBACK_TICK total amount
    if(!error && !this.util.hasBalance(balances, callbackTokenInfo['TICK_ID'], totalCallbackTickAmount))
        error = 'invalid: insufficient funds (CALLBACK_TICK)';

    // Adjust balances to reduce by CALLBACK_TICK total amount
    if(!error)
        balances = this.util.debitBalances(balances, callbackTokenInfo['TICK_ID'], totalCallbackTickAmount);

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

    s.balances = balances;
    return error;
}

module.exports = { validateCallbackToken, validateCallbackState, validateCallbackFunding };
