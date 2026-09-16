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
 * COLLECT settlement: a valid claim moves the reward from the pre-funded REWARD
 * pool to SOURCE (a debit and a credit, never a mint); every claim, valid or
 * not, then posts its ledger changes and refreshes balances and supply.
 *
 ********************************************************************/

// Installed onto Collect.prototype by collect.js; each method runs with `this` bound to
// the handler, exactly as the class method it was.
module.exports = {

    // Pay the reward out of the pool and post the ledger changes
    async payReward(data, status, rewardAmount){

        // Store the SOURCE, GAS tick, and reward pool in addresses list
        let gas        = this.config['GAS'];
        let rewardPool = this.config['ADDRESS']['REWARD'];
        this.util.addAddressTicker(data['SOURCE'], gas);
        this.util.addAddressTicker(rewardPool, gas);

        // Array of credits and debits
        let credits = [],
            debits  = [];

        // Pay the reward by debiting the pre-funded pool and crediting SOURCE
        // (no minting; total XCHAIN supply is unchanged by COLLECT)
        if(status === 'valid'){
            debits.push([gas, rewardAmount, rewardPool]);
            credits.push([gas, rewardAmount, data['SOURCE']]);
        }

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
