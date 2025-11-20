/*********************************************************************
 * 
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 * 
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided “AS IS”, without warranties or conditions of any kind.
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

        // Get info on the swap
        let swapInfo = await this.indexerDb.getSwapInfo(this.config['COIN'], data['ACTION_INDEX']);

        // Add SOURCE address and GET_TICK to addresses list
        this.util.addAddressTicker(swapInfo['SOURCE'], swapInfo['GET_TICK']);

        // Define SWAP_EXPIRE action
        let action = {}
        action['ACTION']      = 'SWAP_EXPIRE';
        action['STATUS']      = 'valid';
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

        // Debit GIVE_TICK from escrows and credit it to the SOURCE address
        escrows.push([swapInfo['GIVE_TICK'], -swapInfo['GIVE_AMOUNT'], swapInfo['SOURCE']]);
        credits.push([swapInfo['GIVE_TICK'],  swapInfo['GIVE_AMOUNT'], swapInfo['SOURCE']]);

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