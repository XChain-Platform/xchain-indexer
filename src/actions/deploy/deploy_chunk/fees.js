/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * XChain Platform - DEPLOY v4 (chunk carrier): the per-byte gas fee
 *
 * Prices a carrier's slice and validates how it is paid (native coin output
 * or the configured GAS token balance). A part of actions/deploy/deploy_chunk.js,
 * called from parse() after the FORMAT validations; the ledger debit itself is
 * written by parse(), which also owns whether a completing carrier hands the
 * fee to the deployment it triggers.
 *
 ********************************************************************/

/**
 * Price the carrier and validate its fee payment.
 *
 * @param {DeployChunk} carrier  the owning chunk handler (config, util, indexerDb, decoderDb)
 * @param {object}      data     the carrier's transaction context. Mutated: the native-fee
 *                               fields when the fee is paid by a native coin output.
 * @param {?string}     error    a verdict already reached, or null
 * @returns {Promise<{error: ?string, partBytes: number, fee: *, gas: string, tokenInfo: ?object, feePaymentMode: number}>}
 */
async function priceCarrier(carrier, data, error){

    /*****************************************************************
     * Gas Fee Calculation
     *
     * A chunk pays the per-byte component for the bytes it puts on-chain
     * (its CODE_PART). The assembling DEPLOY v2/v3 then charges base +
     * constructor only, so net ≈ a single-shot deploy of the same source.
     ****************************************************************/

    let schedule  = carrier.config['GAS_SCHEDULE'];
    let partBytes = error ? 0 : Buffer.byteLength(String(data['CODE_PART']), 'utf8');
    // Priced through util.vmGasCost, the one arithmetic the static quote also uses.
    let gasCost   = carrier.util.vmGasCost(schedule, 'DEPLOY_CARRIER', partBytes);
    let fee       = carrier.util.bcmul(gasCost, carrier.config['GAS_PRICE'], 8);

    // Get source address balances (gas tick)
    let gas       = carrier.config['GAS'];
    let tokenInfo = await carrier.indexerDb.getTokenInfo(gas, data['BLOCK_INDEX'], data['ACTION_INDEX']);
    let balances  = await carrier.indexerDb.getAddressBalances(data['SOURCE'], null, data['BLOCK_INDEX'], data['ACTION_INDEX']);

    // Validate gas fee payment (native coin or XCHAIN balance); mirrors deploy.js
    let feePaymentMode = 2; // default: xchain balance
    // Verify the gas fee is paid, either in native coin or the configured GAS token
    if(!error && tokenInfo && carrier.util.bcgt(fee, 0)){
        let pmMode = carrier.util.detectFeePaymentMode(data, carrier.decoderDb, data['TX_OUTPUTS']);
        if(pmMode === 'native'){
            let tempFees   = { AMOUNT: fee };
            let validation = await carrier.util.validateNativeCoinFee(data, tempFees, carrier.indexerDb, data['TX_OUTPUTS']);
            if(!validation.valid){
                error = 'invalid: ' + (validation.error || 'native coin fee validation failed');
            } else {
                feePaymentMode = 1;
                data['NATIVE_COIN_AMOUNT'] = validation.nativeCoinAmount;
                data['NATIVE_COIN']        = validation.nativeCoin;
                data['ORACLE_ROUND']       = validation.oracleRound;
            }
        } else if(pmMode === 'rejected'){
            error = 'invalid: insufficient fee (native coin output required)';
        } else {
            if(!carrier.util.hasBalance(balances, tokenInfo['TICK_ID'], fee))
                error = 'invalid: insufficient funds (GAS)';
        }
    }

    return { error, partBytes, fee, gas, tokenInfo, feePaymentMode };
}

module.exports = { priceCarrier };
