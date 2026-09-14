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
 * UNSTAKE settlement: the ledger tail both flavors run once their row is
 * recorded, valid or not. UNSTAKE moves no tokens itself (the block-end
 * sweep releases them once the cooldown ends), so the tail posts empty
 * credits and debits.
 *
 ********************************************************************/

// Installed onto Unstake.prototype by unstake.js; each method runs with `this` bound to
// the handler, exactly as the class code it came from.
module.exports = {

    // Post the ledger changes, then refresh balances, token supply and action mappings
    async postLedgerChanges(data, tick){

        // Store the SOURCE and the flavor's tick in addresses list
        this.util.addAddressTicker(data['SOURCE'], tick);

        // Array of credits and debits
        let credits = [],
            debits  = [];

        // Process any transaction ledger changes (credits / debits)
        await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits);

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
