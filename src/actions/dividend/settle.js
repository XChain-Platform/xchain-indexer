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
 * XChain Platform Action - DIVIDEND: settle
 *
 * Takes the DEBIT out of the in-memory balances, records the DIVIDEND
 * with its final status, and applies the ledger rows of a valid one.
 *
 ********************************************************************/

const { getLogger } = require('../../observability/index.js');

// Installed onto Dividend.prototype by index.js; each method runs with `this` bound to the
// handler, exactly as the class method it was.
module.exports = {

    // Require a balance that covers the DIVIDEND_TICK total DEBIT, then take the DEBIT out of the
    // in-memory balances the guard and fee checks are measured against. Returns the error.
    stageDividendDebit(dividend, ctx, error){
        // Verify SOURCE has enough balances to cover DIVIDEND_TICK total DEBIT amount
        if(!error && !this.util.hasBalance(ctx.balances, ctx.dividendTokenInfo['TICK_ID'], dividend['DEBIT']))
            error = 'invalid: insufficient funds (TICK)';

        // Adjust balances to reduce by DIVIDEND_TICK total DEBIT amount
        if(!error)
            ctx.balances = this.util.debitBalances(ctx.balances, ctx.dividendTokenInfo['TICK_ID'], dividend['DEBIT']);
        return error;
    },

    // Record the dividend with its final status and, when it is valid, apply its ledger rows
    // (applyDividendLedger); the action mappings are written either way
    async settleDividend(data, dividend, fees, recipients, ctx, error, guardFee){
        // Determine final status
        let status = (error) ? error : 'valid';
        data['STATUS'] = dividend['STATUS'] = status;

        // Print status message
        getLogger().info("\t DIVIDEND : " + dividend['TICK'] + ' : ' + dividend['DIVIDEND_TICK'] + ' : ' + this.util.logAmount(dividend['AMOUNT']) + ' : ' + dividend['STATUS']);

        // Create record in dividends table
        await this.indexerDb.createDividend(dividend);

        // Store the SOURCE and TICK in addresses list
        this.util.addAddressTicker(data['SOURCE'], fees['TICK']);

        // If this was a valid transaction, then create the credit and debit records
        if(status=='valid')
            await this.applyDividendLedger(data, dividend, fees, recipients, ctx.gasTick, guardFee);

        // Create action mappings
        await this.mapper.createMappings(data);
    },

    // The valid dividend's ledger: debit the total, bill any guard gas, handle the fee, credit each
    // recipient its share, then refresh the touched balances and supplies
    async applyDividendLedger(data, dividend, fees, recipients, gasTick, guardFee){

        // Array of credits and debits
        let credits = [],
            debits  = [];

        // Add DIVIDEND_TICK and DEBIT to debits array
        debits.push([dividend['DIVIDEND_TICK'], dividend['DEBIT'], dividend['SOURCE']]);

        // Bill the controller-guard gas to SOURCE (a GAS burn with no offsetting credit); the
        // end-of-action updateTokens recomputes GAS supply from the ledger so sanityCheck holds.
        if(this.util.bcgt(guardFee, 0)){
            debits.push([gasTick, guardFee, dividend['SOURCE']]);
            this.util.addAddressTicker(dividend['SOURCE'], gasTick);
        }

        // Handle any transaction FEE according the users's ADDRESS preferences
        [credits, debits] = await this.util.processTransactionFees(this.indexerDb, credits, debits, fees);

        // Loop through recipient addresses
        for(let address in recipients){

            // Store the recipient ADDRESS and TICK in addresses list
            this.util.addAddressTicker(address, dividend['DIVIDEND_TICK']);

            // Credit address with DIVIDEND_TICK AMOUNT
            credits.push([dividend['DIVIDEND_TICK'], recipients[address], address]);
        }

        // Process any transaction ledger changes (credits / debits)
        await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits);

        // Get a list of tickers & addresses
        let tickers   = this.util.getTickersList(),
            addresses = Object.keys(this.util.getAddressesList());

        // Update address balances and token supply
        await this.indexerDb.updateBalances(addresses);
        await this.indexerDb.updateTokens(tickers);
    }
};
