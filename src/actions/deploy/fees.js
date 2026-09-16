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
 * XChain Platform - DEPLOY: the base gas fee
 *
 * Prices the deployment, validates how it is paid (native coin output or
 * the configured GAS token balance), and debits it in memory, including the
 * deferred deployment's constructor reserve. A part of actions/deploy/index.js,
 * run by runDeployment after the VM gates. The ledger debit itself is written
 * by settle.js, from the final fee.
 *
 ********************************************************************/

const { GAS_CEILING } = require('./constants.js');

/**
 * Price the deployment and read the source's gas-tick balances.
 *
 * @param {Deploy} deploy  the DEPLOY handler (config, util, indexerDb)
 * @param {object} run     the deployment's run state (mutated: gasCost, fee, gas, tokenInfo, balances)
 */
async function priceDeployment(deploy, run){
    let data = run.data;

    /*****************************************************************
     * Gas Fee Calculation
     ****************************************************************/

    let schedule = deploy.config['GAS_SCHEDULE'];
    let codeBytes = Buffer.byteLength(run.code, 'utf8');
    // Chunked (v2/v3) deploys charge base + constructor only: each v4 carrier already
    // paid the per-byte component for the bytes it put on-chain, so the assembly does
    // not re-charge per byte (net ≈ a single-shot inline deploy of the same source).
    // Priced through util.vmGasCost, the one arithmetic the static quote also uses, so
    // the quoted native output cannot drift from this acceptance number.
    run.gasCost = deploy.util.vmGasCost(schedule, run.isChunked ? 'DEPLOY_CHUNKED' : 'DEPLOY_INLINE', codeBytes);
    run.fee = deploy.util.bcmul(run.gasCost, deploy.config['GAS_PRICE'], 8);

    // Get source address balances
    let gas = run.gas = deploy.config['GAS'];
    run.tokenInfo = await deploy.indexerDb.getTokenInfo(gas, data['BLOCK_INDEX'], data['ACTION_INDEX']);
    run.balances = await deploy.indexerDb.getAddressBalances(data['SOURCE'], null, data['BLOCK_INDEX'], data['ACTION_INDEX']);

    // Debits this SAME action already owes. getAddressBalances bounds at
    // action_index < this action, so a debit incurred at this index (the completing
    // carrier's own gas fee) is invisible to it: apply it here or every check below reads a
    // balance the source no longer has.
    if(run.tokenInfo){
        for(let [debitTick, debitAmount, debitAddress] of run.pendingDebits){
            if(debitAddress === data['SOURCE'] && String(debitTick) === String(gas))
                run.balances = deploy.util.debitBalances(run.balances, run.tokenInfo['TICK_ID'], debitAmount);
        }
    }
}

/**
 * Validate the base-fee payment and settle which mode pays the deployment.
 *
 * @param {Deploy} deploy  the DEPLOY handler (util, indexerDb, decoderDb)
 * @param {object} run     the deployment's run state (mutated: error, feePaymentMode;
 *                         the native-fee fields on run.data when a native output pays)
 */
async function validateFeePayment(deploy, run){
    let data = run.data;
    let fee = run.fee;
    let tokenInfo = run.tokenInfo;

    // Validate gas fee payment: native coin or XCHAIN balance. A deferred deployment does
    // not re-detect the mode:
    // the base fee was validated and paid at the assembler, in the mode THAT transaction's
    // outputs decided, and the mode governs whether constructor gas is debited below.
    run.feePaymentMode = run.paidFeePaymentMode === null ? 2 : Number(run.paidFeePaymentMode); // default: xchain balance
    // Verify the deployer can pay the gas fee, either in native coin or the configured GAS token
    if(!run.error && !run.skipBaseFee && tokenInfo && deploy.util.bcgt(fee, 0)){
        let pmMode = deploy.util.detectFeePaymentMode(data, deploy.decoderDb, data['TX_OUTPUTS']);
        if(pmMode === 'native'){
            let tempFees = { AMOUNT: fee };
            let validation = await deploy.util.validateNativeCoinFee(data, tempFees, deploy.indexerDb, data['TX_OUTPUTS']);
            if(!validation.valid){
                run.error = 'invalid: ' + (validation.error || 'native coin fee validation failed');
            } else {
                run.feePaymentMode = 1;
                data['NATIVE_COIN_AMOUNT'] = validation.nativeCoinAmount;
                data['NATIVE_COIN']        = validation.nativeCoin;
                data['ORACLE_ROUND']       = validation.oracleRound;
            }
        } else if(pmMode === 'rejected'){
            run.error = 'invalid: insufficient fee (native coin output required)';
        } else {
            if(!deploy.util.hasBalance(run.balances, tokenInfo['TICK_ID'], fee))
                run.error = 'invalid: insufficient funds (GAS)';
        }
    }
}

/**
 * Debit the base fee in memory, or check a deferred deployment's constructor reserve.
 *
 * @param {Deploy} deploy  the DEPLOY handler (config, util)
 * @param {object} run     the deployment's run state (mutated: balances, error)
 */
function debitBaseFee(deploy, run){
    // Adjust balances to reduce by gas fee (only for XCHAIN deduction mode). Skipped for a
    // deferred deployment: the base fee was charged at the assembler, so charging it again
    // here (in memory or on the ledger) would bill the deployer twice for one deploy.
    if(!run.error && !run.skipBaseFee && run.tokenInfo && run.feePaymentMode === 2)
        run.balances = deploy.util.debitBalances(run.balances, run.tokenInfo['TICK_ID'], run.fee);

    // This is the one divergence from an inline deploy, and it exists only because A and C are
    // different actions: the source can be drained between them. Before the constructor runs
    // at C it must still hold the worst-case constructor spend, on top of whatever this same
    // action already owes. Only in XCHAIN mode - a deployment whose base fee was paid by a
    // native output is charged nothing further here, exactly as an inline native deploy is.
    if(!run.error && run.skipBaseFee && run.tokenInfo && run.feePaymentMode === 2){
        let gasReserve = deploy.util.bcmul(Math.min(Number(run.gasLimit), GAS_CEILING), deploy.config['GAS_PRICE'], 8);
        if(deploy.util.bcgt(gasReserve, 0) && !deploy.util.hasBalance(run.balances, run.tokenInfo['TICK_ID'], gasReserve))
            run.error = 'invalid: insufficient funds (GAS)';
    }
}

module.exports = { priceDeployment, validateFeePayment, debitBaseFee };
