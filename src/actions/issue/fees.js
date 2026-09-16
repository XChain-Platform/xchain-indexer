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
 * ISSUE fees: the SOURCE balances, preferences and fee object read before any rule
 * runs, the issuance fee priced once every rule has passed, and the check that the
 * fee can be paid (native coin or XCHAIN balance).
 *
 * The protocol fee is charged here through createFeesObject. The xchain-sdk drift
 * gate's fee walk reads every source file of a directory handler, so ISSUE stays
 * enrolled as a fee-charging action with the call in this part.
 *
 * Each function runs with `this` bound to the Issue handler (./index.js calls each as
 * fn.call(this, ctx)) and reads and writes the shared context.
 *
 ********************************************************************/

'use strict';

// The SOURCE balances and preferences and the fee object, read in this order.
async function loadFeeContext(ctx){
    let data = ctx.data;

    // Get source address balances and preferences. At genesis the SOURCE is always GAS,
    // which holds no balances and has set no preferences, so these resolve to the exact
    // empty/default result the queries would return; substituting them skips the
    // table-scanning reads on the ~240k-action genesis block. `balances` is only consumed
    // under a non-zero fee (genesis is fee-exempt, so it stays untouched), and the default
    // preferences object is the literal initializer of getAddressPreferences. Byte-identity
    // of the genesis ledger is asserted by scenario 22's reindex-determinism check.
    let balances    = data['IS_GENESIS']
        ? {}
        : await this.indexerDb.getAddressBalances(data['SOURCE'], null, data['BLOCK_INDEX'], data['ACTION_INDEX']);
    let preferences = data['IS_GENESIS']
        ? { FEE_PREFERENCE: 2, REQUIRE_MEMO: 0, DISPENSER_PREFERENCE: 1 }
        : await this.indexerDb.getAddressPreferences(data['SOURCE'], data['BLOCK_INDEX'], data['ACTION_INDEX']);

    // Create the fees object
    let fees = await this.util.createFeesObject(this.indexerDb, data, preferences);

    Object.assign(ctx, { balances, preferences, fees });
}

// Determine if an issuance FEE is required, and what that fee is (written onto ctx.fees).
async function priceIssuance(ctx){
    let { data, tokenInfo, parentInfo, fees, error } = ctx;

    // The GAS token itself cannot pay an XCHAIN issuance fee to come into
    // existence (chicken-and-egg), so its genesis issuance is fee-exempt.
    // Only the exact GAS tick qualifies (subtokens like XCHAIN.foo do not),
    // and only its first issuance (!tokenInfo). Off regtest, GAS issuance is
    // restricted to the GAS address (checked above), so this cannot be abused.
    let gasBootstrap = (String(data['TICK']).toUpperCase() === String(this.config['GAS']).toUpperCase());

    // Determine if an issuance FEE is required, and what that fee is.
    // VM-emitted ISSUEs (IS_EMISSION) are fee-exempt by design: the deployer
    // already paid DEPLOY/EXECUTE gas (base + per-byte + per-emission gas) and
    // emissions are bounded by maxEmissions, so this is not a spam vector. This
    // mirrors the per-tx db_hits fee, which already skips emissions. The
    // exemption is gated by its own ISSUANCE_FEE_EMISSION_EXEMPT activation so
    // the change in fee behaviour switches over at a coordinated flag-day rather
    // than implicitly the moment a node upgrades (which would fork the ledger
    // between node versions on the first constructor that emits an ISSUE).
    // Before activation every node charges the fee (old behaviour); after it
    // every node exempts.
    let issuanceFeeActive = await this.actions.protocolChanges.isEnabled('ISSUANCE_FEE', data['BLOCK_INDEX']);
    let emissionExempt    = await this.actions.protocolChanges.isEnabled('ISSUANCE_FEE_EMISSION_EXEMPT', data['BLOCK_INDEX']);
    if(!error && !tokenInfo && !gasBootstrap && !data['IS_GENESIS'] && !(data['IS_EMISSION'] && emissionExempt) && issuanceFeeActive){
        let unifiedFees = await this.actions.protocolChanges.isEnabled('UNIFIED_FEES', data['BLOCK_INDEX']);
        if(unifiedFees){
            // Unified gas schedule
            let schedule = this.config['GAS_SCHEDULE'];
            let gasCost  = parentInfo ? schedule.ISSUE_SUBTOKEN : schedule.ISSUE;
            fees['GAS_COST']     = gasCost;
            fees['AMOUNT']       = this.util.bcmul(gasCost, this.config['GAS_PRICE'], 8);
            fees['FEE_VERSION']  = 2;
        } else {
            // Legacy per-chain fee
            if(parentInfo)
                fees['AMOUNT'] = this.config['ISSUANCE_FEE_SUBTOKEN'];
            else
                fees['AMOUNT'] = this.config['ISSUANCE_FEE_TOKEN'];
        }
    }
}

// Validate fee payment (native coin or XCHAIN balance), then take an XCHAIN fee off the
// in-memory SOURCE balances.
async function validateFeePayment(ctx){
    let { data, fees } = ctx;
    let error = ctx.error;
    let balances = ctx.balances;

    // Validate fee payment (native coin or XCHAIN balance)
    if(!error && this.util.bcgt(fees['AMOUNT'], 0)){
        let paymentMode = this.util.detectFeePaymentMode(data, this.decoderDb, data['TX_OUTPUTS']);
        if(paymentMode === 'native'){
            // Native coin fee: validate against oracle price
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
            // XCHAIN balance deduction (default)
            if(!this.util.hasBalance(balances, fees['TICK_ID'], fees['AMOUNT']))
                error = 'invalid: insufficient funds (FEE)';
        }
    }

    // Adjust balances to reduce by FEE AMOUNT (only for XCHAIN deduction mode)
    if(!error && (!fees['PAYMENT_MODE'] || fees['PAYMENT_MODE'] === 2))
        balances = this.util.debitBalances(balances, fees['TICK_ID'], fees['AMOUNT']);

    ctx.error = error;
    ctx.balances = balances;
}

module.exports = { loadFeeContext, priceIssuance, validateFeePayment };
