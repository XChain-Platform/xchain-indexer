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
 * SWEEP fee: price the transaction under the unified gas schedule or the
 * legacy database-hits model (each behind its own flag day), then validate how
 * SOURCE pays it and reserve an XCHAIN-paid fee out of the swept balances.
 *
 ********************************************************************/

// Installed onto Sweep.prototype by sweep.js; each method runs with `this` bound to
// the handler, exactly as the parse() code it came from. `state` is the object
// loadSweepState() built: the fee writes land in state.fees, and a fee reserved out
// of the swept balances replaces state.balances.
module.exports = {

    // Split the escrows by the enabled close flags, then price the SWEEP into state.fees
    async priceSweepFee(data, state){
        let escrowed = state.escrowed;

        // Partition escrow rows by type so we can fee + iterate per enabled flag
        state.orderEscrows     = (data['ORDERS']     == 1) ? escrowed.filter(e => e.type === 'order')     : [];
        state.swapEscrows      = (data['SWAPS']      == 1) ? escrowed.filter(e => e.type === 'swap')      : [];
        state.dispenserEscrows = (data['DISPENSERS'] == 1) ? escrowed.filter(e => e.type === 'dispenser') : [];

        // Determine the total transaction FEE. UNIFIED_FEES_SWEEP_CALLBACK gates the move off
        // the legacy per-DB-hit model: the legacy price has no floor, so on LTC/DOGE (where
        // detectFeePaymentMode REJECTS a missing native-coin fee output rather than falling
        // back to an XCHAIN debit) a small SWEEP priced below the chain's dust threshold and
        // could not be submitted at all. Below the flag-day the legacy model is reproduced
        // exactly so a pre-activation replay commits the identical fee. See
        // protocol_changes.js.
        let unifiedFees = await this.actions.protocolChanges.isEnabled('UNIFIED_FEES_SWEEP_CALLBACK', data['BLOCK_INDEX']);
        if(unifiedFees)
            this.priceUnifiedSweepFee(data, state);
        else
            await this.priceLegacySweepFee(data, state);
    },

    // At/after UNIFIED_FEES_SWEEP_CALLBACK: SWEEP_BASE plus SWEEP_PER_ITEM per settled item
    priceUnifiedSweepFee(data, state){
        let { fees, balances, ownerships, orderEscrows, swapEscrows, dispenserEscrows } = state;

        // Unified gas schedule: a flat base plus one per-item charge, at DIVIDEND/AIRDROP
        // per-recipient parity. An ITEM is one unit of settlement work this SWEEP commits:
        // one swept balance, one closed order/swap/dispenser escrow, or one transferred
        // ownership. It counts exactly what the settlement block below writes, and reads
        // the same `balances` / `ownerships` / escrow views the legacy db_hits count read,
        // at the same point in the handler (BEFORE any controller-guard fee debits it), so
        // the two models see identical inputs and only the price changes.
        // The flags are tested with `== 1`, the way the settlement blocks below test
        // them, NOT with the legacy branch's bare truthiness. Those fields arrive as
        // wire strings ('0') or mathjs bignumbers, and BOTH are truthy in JS, so the
        // legacy `(data['BALANCES']) ? ...` charged for balances a BALANCES=0 sweep
        // never moves. Correcting that here is safe precisely because it is a NEW
        // price behind a NEW flag day: the legacy branch is untouched, so every
        // pre-activation fee still replays byte-for-byte.
        let items = 0;
        items += (data['BALANCES']==1)   ? Number(Object.keys(balances).length)   : 0;
        items += Number(orderEscrows.length + swapEscrows.length + dispenserEscrows.length);
        items += (data['OWNERSHIPS']==1) ? Number(Object.keys(ownerships).length) : 0;
        let result = this.util.getUnifiedBaseItemFee(items, 'SWEEP_BASE', 'SWEEP_PER_ITEM');
        fees['GAS_COST']    = result.gasCost;
        fees['AMOUNT']      = result.fee;
        fees['FEE_VERSION'] = 2;
    },

    // Below UNIFIED_FEES_SWEEP_CALLBACK: the per-database-hit price
    async priceLegacySweepFee(data, state){
        let { fees, balances, ownerships, orderEscrows, swapEscrows, dispenserEscrows } = state;

        // Legacy: database hits model. LEGACY_FEE_NUMERIC_DBHITS gates the db_hits
        // string-concatenation fix: below THAT flag-day reproduce the original
        // `+= bcmul(...)` concatenation byte-for-byte. The escrow term has no ternary
        // guard, so even a zero-escrow SWEEP concatenated "0" onto db_hits
        // (1 -> "10" -> "100") and inflated the fee; the below-flag path preserves that so
        // a pre-activation replay commits the identical fee. At/above it accumulate
        // numerically. See protocol_changes.js.
        let numericDbHits = await this.actions.protocolChanges.isEnabled('LEGACY_FEE_NUMERIC_DBHITS', data['BLOCK_INDEX']);
        let db_hits = 1;                                                                                                                        // 1 sweeps
        if(numericDbHits){
            db_hits += (data['BALANCES'])   ? Number(Object.keys(balances).length) * 4                                                   : 0;   // 1 debits, 1 credits, 2 balances
            db_hits += Number(orderEscrows.length + swapEscrows.length + dispenserEscrows.length) * 4;                                          // 1 escrows, 1 credits, 2 balances (per affected offer)
            db_hits += (data['OWNERSHIPS']) ? Number(Object.keys(ownerships).length) * 2                                                 : 0;   // 1 issue, 1 tokens
        } else {
            db_hits += (data['BALANCES'])   ? this.util.bcmul(Object.keys(balances).length, 4, 0)                                        : 0;   // 1 debits, 1 credits, 2 balances
            db_hits += this.util.bcmul(orderEscrows.length + swapEscrows.length + dispenserEscrows.length, 4, 0);                               // 1 escrows, 1 credits, 2 balances (per affected offer)
            db_hits += (data['OWNERSHIPS']) ? this.util.bcmul(Object.keys(ownerships).length, 2, 0)                                      : 0;   // 1 issue, 1 tokens
        }
        fees['AMOUNT'] = this.util.getTransactionFee(db_hits, fees['TICK']);
    },

    // Validate how SOURCE pays the fee, then reserve an XCHAIN-paid fee out of the swept
    // balances. Returns the error.
    async validateSweepFeePayment(data, state, error){
        let fees = state.fees;

        // Emitted (VM-synthesized) actions pay no separate per-tx fee. See util.feeForAction.
        // Without this, a nonzero fee + detectFeePaymentMode('xchain') rejects every
        // contract-emitted SWEEP as 'insufficient funds (FEE)'.
        fees['AMOUNT'] = this.util.feeForAction(fees['AMOUNT'], data);

        // DEBUG
        // console.log('source=',data['SOURCE']);
        // console.log('balances=',balances);
        // console.log('ownerships=',ownerships);
        // console.log('preferences=',preferences);
        // console.log('db_hits=',db_hits);
        // console.log('fees=',fees);
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
                if(!this.util.hasBalance(state.balances, fees['TICK_ID'], fees['AMOUNT']))
                    error = 'invalid: insufficient funds (FEE)';
            }
        }

        // Adjust balances to reduce by FEE AMOUNT (only for XCHAIN deduction mode)
        if(!error && (!fees['PAYMENT_MODE'] || fees['PAYMENT_MODE'] === 2))
            state.balances = this.util.debitBalances(state.balances, fees['TICK_ID'], fees['AMOUNT']);
        return error;
    }
};
