/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Platform Action - SWAP_EXPIRE
 * 
 * This action processes swaps that have expired
 *
 ********************************************************************/

class Swap_Expire {

    // Handle constructing a class instance
    constructor(action){
        // Setup short aliases
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;
    }

    // Handle expiring a swap
    async parse(params, data, error){

        // Get info on the swap by action_index. Pass null coin (not the local COIN) so a
        // cross-chain swap (get_coin = counterparty chain) is also located on expiry.
        let swapInfo = await this.indexerDb.getSwapInfo(null, data['ACTION_INDEX']);

        // Bail out if swap no longer exists (already expired or rolled back)
        if(!swapInfo)
            return;

        // Add SOURCE address and GIVE_TICK to addresses list
        this.util.addAddressTicker(swapInfo['SOURCE'], swapInfo['GIVE_TICK']);

        // Define SWAP_EXPIRE action
        let action = {}
        action['ACTION']      = 'SWAP_EXPIRE';
        action['BLOCK_INDEX'] = data['BLOCK_INDEX'];

        // Create a record of this SWAP_EXPIRE action in the actions table
        data['ACTION_INDEX'] = await this.indexerDb.createActionIndex(action);

        // Set the status to valid
        data['STATUS'] = 'valid';

        // Print status message
        console.log("\t SWAP_EXPIRE : " + this.config['COIN'] + ':' + swapInfo['ACTION_INDEX'] + ' : ' + data['STATUS']);

        // Array of credits, debits, and escrows
        let credits = [],
            debits  = [],
            escrows = [];

        if(swapInfo['GIVE_OWNERSHIP']==1){
            // Release ownership escrow back to the seller (tokens.owner_id is unchanged)
            await this.indexerDb.clearTokenEscrow(swapInfo['GIVE_TICK']);
        } else {
            // Debit GIVE_TICK from escrows and credit it to the SOURCE address
            escrows.push([swapInfo['GIVE_TICK'], -swapInfo['GIVE_AMOUNT'], swapInfo['SOURCE']]);
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
}

module.exports = Swap_Expire;