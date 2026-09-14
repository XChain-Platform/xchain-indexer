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
 * SWAP_EXPIRE settlement: hand the expired swap's GIVE side back to its SOURCE
 * (an ownership escrow is released, a balance escrow is refunded), record the
 * expiry and its status, then post the ledger changes and refresh balances.
 *
 ********************************************************************/

// Installed onto Swap_Expire.prototype by swap_expire.js; each method runs with `this`
// bound to the handler, exactly as the class method it was.
module.exports = {

    // Refund the expired swap's escrow, record the expiry and post the ledger changes
    async settleExpiry(data, swapInfo){

        // Array of credits, debits, and escrows
        let credits = [],
            debits  = [],
            escrows = [];

        if(swapInfo['GIVE_OWNERSHIP']==1){
            // Release ownership escrow back to the seller (tokens.owner_id is unchanged)
            await this.indexerDb.clearTokenEscrow(swapInfo['GIVE_TICK']);
        } else {
            // Debit GIVE_TICK from escrows and credit it to the SOURCE address.
            // BigNumber-space negation, not JS unary minus (float truncation).
            escrows.push([swapInfo['GIVE_TICK'], this.util.bcsub(0, swapInfo['GIVE_AMOUNT'], 64), swapInfo['SOURCE']]);
            credits.push([swapInfo['GIVE_TICK'],  swapInfo['GIVE_AMOUNT'], swapInfo['SOURCE']]);
        }

        // Create record in the swaps_expires table
        await this.indexerDb.createSwapExpire(data['ACTION_INDEX'], swapInfo['ACTION_INDEX'], data['STATUS']);

        // Create record in the swaps_statuses table
        await this.indexerDb.createSwapStatus(data['ACTION_INDEX'], swapInfo['ACTION_INDEX'], 'expired');

        // Process any transaction ledger changes (credits / debits / escrows)
        await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits, escrows);

        // Get a list of tickers & addresses
        let tickers   = this.util.getTickersList(),
            addresses = Object.keys(this.util.getAddressesList());

        // Update address balances and token supply
        await this.indexerDb.updateBalances(addresses);
        await this.indexerDb.updateTokens(tickers);

        // Create action mappings
        await this.mapper.createMappings(data);
    }
};
