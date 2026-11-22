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
 * XChain Platform Action - EXECUTE : gas fee pricing and payment
 *
 * Prices execution admission and decides HOW the fee is paid (native coin
 * output or XCHAIN balance), which is what the settlement phase later bills
 * and debits. Native payment buys a bounded gas budget after its height gate;
 * the ledger lane retains base admission. Called with the EXECUTE handler as
 * `this` (see ./index.js).
 *
 ********************************************************************/

'use strict';

const gateRegistry = require('../../consensus/gate_registry');

const EXECUTE_NATIVE_METERED_GAS_KEY =
    'execute_native_metered_gas_activation.EXECUTE_NATIVE_METERED_GAS_ACTIVATION';

/*****************************************************************
 * Gas Fee Calculation
 ****************************************************************/

// Native-coin payment: the fee is covered by a coin output on the transaction
// rather than a GAS balance, so the validated amount and the oracle round it
// was priced at are stamped onto data for the ledger writer.
async function payFeeFromNativeCoin(ctx, limits, meteredNativeGas){
    let data = ctx.data;
    let tempFees = { AMOUNT: ctx.fee };
    let validation = await this.util.validateNativeCoinFee(data, tempFees, this.indexerDb, data['TX_OUTPUTS']);
    if(!validation.valid){
        ctx.error = 'invalid: ' + (validation.error || 'native coin fee validation failed');
    } else {
        ctx.feePaymentMode = 1;
        data['NATIVE_COIN_AMOUNT'] = validation.nativeCoinAmount;
        data['NATIVE_COIN']        = validation.nativeCoin;
        data['ORACLE_ROUND']       = validation.oracleRound;
        if(meteredNativeGas){
            // validateNativeCoinFee accepts the output at minAcceptableAmount, so invert
            // that same lower edge of the tolerance band. A payment accepted for N gas
            // therefore always buys at least N gas, while every extra satoshi increases
            // the budget through the identical oracle-price path.
            let paidGas = this.util.bcmuldivfloor(
                validation.nativeCoinAmount, ctx.gasCost,
                validation.minAcceptableAmount, 0);
            ctx.paidGasCeiling = Math.min(
                Math.max(Number(ctx.gasCost), this.util.bcfloor(paidGas)), limits.GAS_CEILING);
        }
    }
}

async function chargeGasFee(ctx, limits){
    let data = ctx.data;

    let schedule = this.config['GAS_SCHEDULE'];
    // Base execution gas (actual VM gas will be metered during execution), priced through
    // util.vmGasCost, the one arithmetic the static quote also uses.
    ctx.gasCost = this.util.vmGasCost(schedule, 'EXECUTE', 0);
    ctx.fee = this.util.bcmul(ctx.gasCost, this.config['GAS_PRICE'], 8);

    // Get source address balances
    ctx.gas = this.config['GAS'];
    ctx.tokenInfo = await this.indexerDb.getTokenInfo(ctx.gas, data['BLOCK_INDEX'], data['ACTION_INDEX']);
    ctx.balances = await this.indexerDb.getAddressBalances(data['SOURCE'], null, data['BLOCK_INDEX'], data['ACTION_INDEX']);

    // Validate gas fee payment (native coin or XCHAIN balance).
    // System-injected EXECUTEs (e.g. attestation callbacks injected by
    // attest/callbacks.js injectCallbackExecute) skip fee accounting: those run against
    // the request's gas_escrow, not the synthetic SOURCE's wallet. Fee deduction
    // from gas_escrow on the request row is not currently wired.
    ctx.feePaymentMode = 2; // default: xchain balance
    ctx.skipFee = Boolean(data['IS_EMISSION']);
    if(!ctx.error && !ctx.skipFee && ctx.tokenInfo && this.util.bcgt(ctx.fee, 0)){
        let pmMode = this.util.detectFeePaymentMode(data, this.decoderDb, data['TX_OUTPUTS']);
        if(pmMode === 'native'){
            let meteredNativeGas = gateRegistry.activeAt(EXECUTE_NATIVE_METERED_GAS_KEY,
                this.config['NETWORK'], this.config['COIN'], Number(data['BLOCK_INDEX']), null);
            await payFeeFromNativeCoin.call(this, ctx, limits, meteredNativeGas);
        } else if(pmMode === 'rejected'){
            ctx.error = 'invalid: insufficient fee (native coin output required)';
        } else {
            if(!this.util.hasBalance(ctx.balances, ctx.tokenInfo['TICK_ID'], ctx.fee))
                ctx.error = 'invalid: insufficient funds (GAS)';
        }
    }

    // Adjust balances to reduce by gas fee (only for XCHAIN deduction mode, never for system-injected)
    if(!ctx.error && !ctx.skipFee && ctx.tokenInfo && ctx.feePaymentMode === 2)
        ctx.balances = this.util.debitBalances(ctx.balances, ctx.tokenInfo['TICK_ID'], ctx.fee);
}

module.exports = { chargeGasFee };
