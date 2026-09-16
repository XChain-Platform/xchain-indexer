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
 * DELEGATE settlement: the contract-targeted revoke's deactivation write, and
 * the ledger tail every flavor runs once its row is recorded, valid or not.
 * DELEGATE moves no tokens, so the tail posts empty credits and debits.
 *
 ********************************************************************/

// Installed onto Delegate.prototype by delegate.js; each method runs with `this` bound to
// the handler, exactly as the class code it came from.
module.exports = {

    // Mark the contract_delegations row's deactivation_block (BLOCK_INDEX + activation delay)
    async deactivateContractSlot(data){
        let deactivationBlock = parseInt(data['BLOCK_INDEX']) + this.activationDelay();
        let valid_id  = await this.indexerDb.getStatusId('valid');
        let pubkey_id = await this.indexerDb.getPubkeyId(String(data['SIGNING_PUBKEY']).toLowerCase());
        let tick_id   = await this.indexerDb.getTickerId(data['TICK']);
        await this.indexerDb.deactivateContractDelegation(
            deactivationBlock, Number(data['TARGET_CONTRACT_INDEX']), pubkey_id, tick_id, valid_id);
    },

    // Post the ledger changes, then refresh balances, token supply and action mappings
    async postLedgerChanges(data, tick){

        // Store the SOURCE in addresses list
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
