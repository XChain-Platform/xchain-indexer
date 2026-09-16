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
 * XChain Indexer - ATTEST handler part
 *
 * The v0 request fee: its format and precision rules, the funding check against the
 * payer's balance, and the escrow written once the request row exists.
 *
 * Installed onto Attest.prototype by actions/attest/index.js, so call sites stay
 * this.<method>().
 *
 ********************************************************************/

'use strict';

module.exports = {
    // The optional request fee's own rules. Returns the verdict plus whether a fee is
    // actually present, which every later phase keys on.
    async requestFeeFormatError(data, error){
        // Optional request fee. XCHAIN-only in v1: the validator_rewards →
        // COLLECT payout chain is GAS-denominated, so consensus pins FEE_TICK to
        // the GAS tick. The field exists on the wire so post-launch multi-tick
        // support is a rule loosening, not a format change.
        if(!error && !this.util.isNull(data['FEE_TICK']) && data['FEE_TICK'] !== this.config['GAS'])
            error = 'invalid: FEE_TICK (only ' + this.config['GAS'] + ' accepted)';

        // isValidFiatFormat = isValidAmountFormat + a decimal-place cap. The fee
        // must not carry more precision than the GAS tick is issued with: the
        // escrow/debit/credit ledger rows round to the tick's decimals
        // (createLedgerChangeRecord), so a finer fee would be CHARGED rounded
        // while attests.fee_amount keeps the unrounded string, desyncing the
        // reward split (computed from the unrounded fee_amount) from the escrow.
        // Cap at min(8, gasDecimals): 8 is the hard ceiling the equal split
        // floors to (bcmulfloor(...,8)); gasDecimals is the consensus precision
        // of the GAS tick (8 for the production XCHAIN genesis issuance, 0 on
        // the decimals-0 regtest GAS tick). Deterministic: every validator
        // replaying from genesis reads the same issues-table state at this block.
        if(!error && !this.util.isNull(data['FEE_AMOUNT'])){
            let gasDecimals = await this.indexerDb.getTokenDecimalPrecision(
                await this.indexerDb.getTickerId(this.config['GAS'])
            );
            let feeCap = Math.min(8, gasDecimals);
            if(!this.util.isValidFiatFormat(feeCap, data['FEE_AMOUNT'], data['BLOCK_TIME']))
                error = 'invalid: FEE_AMOUNT (precision > ' + feeCap + ' dp)';
        }

        let feePresent = !error && !this.util.isNull(data['FEE_AMOUNT']) && this.util.bcgt(data['FEE_AMOUNT'], '0');
        if(!error && feePresent && this.util.isNull(data['FEE_TICK']))
            error = 'invalid: FEE_TICK (required when FEE_AMOUNT > 0)';

        return { error, feePresent };
    },

    async requestFeeFundingError(data, error, feePresent){
        // Fee escrow funding check: FEE_PAYER (the EXECUTE caller) must hold the
        // fee. Read at (BLOCK_INDEX, ACTION_INDEX) so accept/reject is identical
        // across all validators (same determinism rule as COLLECT's pool check).
        if(!error && feePresent){
            let tokenInfo = await this.indexerDb.getTokenInfo(this.config['GAS'], data['BLOCK_INDEX'], data['ACTION_INDEX']);
            let balances  = await this.indexerDb.getAddressBalances(data['FEE_PAYER'], null, data['BLOCK_INDEX'], data['ACTION_INDEX']);
            if(!tokenInfo || !this.util.hasBalance(balances, tokenInfo['TICK_ID'], data['FEE_AMOUNT']))
                error = 'invalid: insufficient funds (FEE_AMOUNT)';
        }

        return error;
    },

    async escrowRequestFee(data, status, feePresent){
        // Escrow the fee from FEE_PAYER (debit + escrow at this v0 action_index;
        // released to the REWARD pool on fulfillment, refunded on expiry/error).
        // Rollback safety is the generic path: escrows/debits delete by
        // action_index, and the request row resets via resolved_block.
        if(status === 'valid' && feePresent){
            let gas = this.config['GAS'];
            this.util.addAddressTicker(data['FEE_PAYER'], gas);
            let debits  = [[gas, data['FEE_AMOUNT'], data['FEE_PAYER']]];
            let escrows = [[gas, data['FEE_AMOUNT'], data['FEE_PAYER']]];
            await this.util.processTransactionLedgerChanges(this.indexerDb, data, [], debits, escrows);
            let tickers   = this.util.getTickersList(),
                addresses = Object.keys(this.util.getAddressesList());
            await this.indexerDb.updateBalances(addresses);
            await this.indexerDb.updateTokens(tickers);
        }
    }
};
