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
 * XChain Platform Action - SWAP_MATCH
 * 
 * This action finds and processes matching swap actions
 *
 ********************************************************************/

class Swap_Match {

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

    // Handle looking for a matching swap
    async parse(params, data, error){

        // Clone the raw data into a swap object
        let swap = structuredClone(data);

        // Get information on a swap given the COIN network and SWAP_ACTION_INDEX
        let swapIndex = (!this.util.isNull(data['SWAP_ACTION_INDEX'])) ? data['SWAP_ACTION_INDEX'] : data['ACTION_INDEX'];
        let swapInfo  = await this.indexerDb.getSwapInfo(this.config['COIN'], swapIndex)

        // Get a list of any matching open swaps
        let matches = await this.indexerDb.getSwapMatches(data);
        if(matches){
            // Get information on the tokens involved in the swap
            let getTokenInfo  = await this.indexerDb.getTokenInfo(data['GET_TICK'],  data['BLOCK_INDEX'], data['ACTION_INDEX']);
            let giveTokenInfo = await this.indexerDb.getTokenInfo(data['GIVE_TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX']);

            // List of addresses allowed or blocked from holding GET_TICK
            let getTokenAllowList = (getTokenInfo['ALLOW_LIST']) ? await this.indexerDb.getList(getTokenInfo['ALLOW_LIST']) : false;
            let getTokenBlockList = [getTokenInfo['BLOCK_LIST']] ? await this.indexerDb.getList(getTokenInfo['BLOCK_LIST']) : false;

            // List of addresses allowed or blocked from holding GIVE_TICK
            let giveTokenAllowList = (giveTokenInfo['ALLOW_LIST']) ? await this.indexerDb.getList(giveTokenInfo['ALLOW_LIST']) : false;
            let giveTokenBlockList = [giveTokenInfo['BLOCK_LIST']] ? await this.indexerDb.getList(giveTokenInfo['BLOCK_LIST']) : false;

            // List of addresses allowed or blocked from matching with this SWAP
            let swapInfoAllowList = (swapInfo['ALLOW_LIST']) ? await this.indexerDb.getList(swapInfo['ALLOW_LIST']) : false;
            let swapInfoBlockList = [swapInfo['BLOCK_LIST']] ? await this.indexerDb.getList(swapInfo['BLOCK_LIST']) : false;

            // Loop through matches and determine if we have a valid match
            let match = false;
            for(let swap of matches){
                let valid = true;

                // List of addresses allowed or blocked from matching with this matching SWAP
                let matchInfoAllowList = (swap['ALLOW_LIST']) ? await this.indexerDb.getList(swap['ALLOW_LIST']) : false;
                let matchInfoBlockList = [swap['BLOCK_LIST']] ? await this.indexerDb.getList(swap['BLOCK_LIST']) : false;

                // Check if GET_ADDRESS for both sides of swap are allowed (ALLOW/BLOCK list support)
                if((getTokenAllowList.length  && (!getTokenAllowList.includes(data['GET_ADDRESS'])  || !getTokenAllowList.includes(swap['GET_ADDRESS'])))  ||
                   (getTokenBlockList.length  && ( getTokenBlockList.includes(data['GET_ADDRESS'])  ||  getTokenBlockList.includes(swap['GET_ADDRESS'])))  ||
                   (giveTokenAllowList.length && (!giveTokenAllowList.includes(data['GET_ADDRESS']) || !giveTokenAllowList.includes(swap['GET_ADDRESS']))) ||
                   (giveTokenBlockList.length && ( giveTokenBlockList.includes(data['GET_ADDRESS']) ||  giveTokenBlockList.includes(swap['GET_ADDRESS']))) ||
                   (swapInfoAllowList.length  && !swapInfoAllowList.includes(swap['GET_ADDRESS']))  ||
                   (swapInfoBlockList.length  &&  swapInfoBlockList.includes(swap['GET_ADDRESS']))  || 
                   (matchInfoAllowList.length && !matchInfoAllowList.includes(data['GET_ADDRESS'])) ||
                   (matchInfoBlockList.length &&  matchInfoBlockList.includes(data['GET_ADDRESS']))){
                    valid = false;
                }

                // If we found a valid match, stop looking for additional matches
                if(valid){
                    match = swap;
                    break;
                }
            }

            // Process the swap match
            // TODO : Revisit this code once multi-chain swap support is added to xchain-hub component
            if(match){

                // Set the status to valid
                data['STATUS'] = 'valid';

                // Print status message
                console.log("\t SWAP_MATCH : " + data['GIVE_AMOUNT'] + ' ' + this.config['COIN'] + ':' + data['GIVE_TICK'] + ' = '  +  data['GET_AMOUNT'] + ' ' + data['GET_COIN'] + ':' + data['GET_TICK'] + ' : ' + data['STATUS']);

                // Array of credits, debits, and escrows
                let credits = [],
                    debits  = [],
                    escrows = [];

                // Define SWAP_MATCH action
                let action = {}
                action['BLOCK_INDEX'] = data['BLOCK_INDEX'];
                action['TX_INDEX']    = data['TX_INDEX']
                action['ACTION']      = 'SWAP_MATCH';

                // Create a record of this SWAP_MATCH action in the actions table
                data['ACTION_INDEX'] = await this.indexerDb.createActionIndex(action);

                // Store the SOURCE and GET_TICK in addresses list
                this.util.addAddressTicker(match['SOURCE'], match['GET_TICK']);

                // Credit tokens to GET_ADDRESS in swaps
                credits.push([match['GET_TICK'], match['GET_AMOUNT'], match['GET_ADDRESS']]);
                credits.push([swap['GET_TICK'],  swap['GET_AMOUNT'],  swap['GET_ADDRESS']]);

                // Debit tokens from escrows table 
                escrows.push([match['GET_TICK'], -match['GET_AMOUNT'], match['SOURCE']]);
                escrows.push([swap['GET_TICK'],  -swap['GET_AMOUNT'],  swap['SOURCE']]);

                // Store the GET_ADDRESS and TICK in addresses list
                this.util.addAddressTicker(match['GET_ADDRESS'], match['GET_TICK']);
                this.util.addAddressTicker(swap['GET_ADDRESS'],  swap['GET_TICK']);

                // Process any transaction ledger changes (credits / debits / escrows)
                await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits, escrows);

                // Create record of match in swap_matches table
                await this.indexerDb.createSwapMatch(data, swap, match);

                // Update record in swaps table to change status (open->complete)
                await this.indexerDb.createSwapStatus(data['ACTION_INDEX'], swap['ACTION_INDEX'],  'complete');
                await this.indexerDb.createSwapStatus(data['ACTION_INDEX'], match['ACTION_INDEX'], 'complete');

                // Get a list of addresses
                let addresses = Object.keys(this.util.getAddressesList());

                // Update address balances
                await this.indexerDb.updateBalances(addresses);

                // Create action mappings
                await this.mapper.createMappings(data);
            }
        }

    }
}

module.exports = Swap_Match;