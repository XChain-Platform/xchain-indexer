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
        let matches = await this.indexerDb.findSwapMatches(data);
        if(matches){
            // Get information on the tokens involved in the swap
            let getTokenInfo  = await this.indexerDb.getTokenInfo(swapInfo['GET_TICK'],  swap['BLOCK_INDEX'], swap['ACTION_INDEX']);
            let giveTokenInfo = await this.indexerDb.getTokenInfo(swapInfo['GIVE_TICK'], swap['BLOCK_INDEX'], swap['ACTION_INDEX']);

            // List of addresses allowed or blocked from holding GET_TICK
            let getTokenAllowList = (!this.util.isNull(getTokenInfo['ALLOW_LIST'])) ? await this.indexerDb.getList(getTokenInfo['ALLOW_LIST']) : false;
            let getTokenBlockList = (!this.util.isNull(getTokenInfo['BLOCK_LIST'])) ? await this.indexerDb.getList(getTokenInfo['BLOCK_LIST']) : false;

            // List of addresses allowed or blocked from holding GIVE_TICK
            let giveTokenAllowList = (!this.util.isNull(giveTokenInfo['ALLOW_LIST'])) ? await this.indexerDb.getList(giveTokenInfo['ALLOW_LIST']) : false;
            let giveTokenBlockList = (!this.util.isNull(giveTokenInfo['BLOCK_LIST'])) ? await this.indexerDb.getList(giveTokenInfo['BLOCK_LIST']) : false;

            // List of addresses allowed or blocked from matching with this SWAP
            let swapInfoAllowList = (!this.util.isNull(swapInfo['ALLOW_LIST'])) ? await this.indexerDb.getList(swapInfo['ALLOW_LIST']) : false;
            let swapInfoBlockList = (!this.util.isNull(swapInfo['BLOCK_LIST'])) ? await this.indexerDb.getList(swapInfo['BLOCK_LIST']) : false;

            // Loop through matches and determine if we have a valid match
            let matchInfo = false;
            for(let match of matches){
                let valid = true;

                // List of addresses allowed or blocked from matching with this matching SWAP
                let matchInfoAllowList = (!this.util.isNull(match['ALLOW_LIST'])) ? await this.indexerDb.getList(match['ALLOW_LIST']) : false;
                let matchInfoBlockList = (!this.util.isNull(match['BLOCK_LIST'])) ? await this.indexerDb.getList(match['BLOCK_LIST']) : false;

                // Check if GET_ADDRESS for both sides of swap are allowed (ALLOW/BLOCK list support)
                if((getTokenAllowList.length  && (!getTokenAllowList.includes(swapInfo['GET_ADDRESS'])  || !getTokenAllowList.includes(match['GET_ADDRESS'])))  ||
                   (getTokenBlockList.length  && ( getTokenBlockList.includes(swapInfo['GET_ADDRESS'])  ||  getTokenBlockList.includes(match['GET_ADDRESS'])))  ||
                   (giveTokenAllowList.length && (!giveTokenAllowList.includes(swapInfo['GET_ADDRESS']) || !giveTokenAllowList.includes(match['GET_ADDRESS']))) ||
                   (giveTokenBlockList.length && ( giveTokenBlockList.includes(swapInfo['GET_ADDRESS']) ||  giveTokenBlockList.includes(match['GET_ADDRESS']))) ||
                   (swapInfoAllowList.length  && !swapInfoAllowList.includes(match['GET_ADDRESS']))     ||
                   (swapInfoBlockList.length  &&  swapInfoBlockList.includes(match['GET_ADDRESS']))     || 
                   (matchInfoAllowList.length && !matchInfoAllowList.includes(swapInfo['GET_ADDRESS'])) ||
                   (matchInfoBlockList.length &&  matchInfoBlockList.includes(swapInfo['GET_ADDRESS']))){
                    valid = false;
                }

                // If we found a valid match, stop looking for additional matches
                if(valid){
                    matchInfo = match;
                    break;
                }
            }

            // Process the swap match
            // TODO : Revisit this code once multi-chain swap support is added to xchain-hub component
            if(matchInfo){

                // Set the status to valid
                data['STATUS'] = 'valid';

                // Print status message
                console.log("\t SWAP_MATCH : " + swapInfo['GIVE_AMOUNT'] + ' ' + swapInfo['GIVE_COIN'] + ':' + swapInfo['GIVE_TICK'] + ' = '  +  swapInfo['GET_AMOUNT'] + ' ' + swapInfo['GET_COIN'] + ':' + swapInfo['GET_TICK'] + ' : ' + data['STATUS']);

                // Array of credits, debits, and escrows
                let credits = [],
                    debits  = [],
                    escrows = [];

                // Define SWAP_MATCH action
                let action = {}
                action['ACTION']      = 'SWAP_MATCH';
                action['BLOCK_INDEX'] = data['BLOCK_INDEX'];

                // Create a record of this SWAP_MATCH action in the actions table
                data['ACTION_INDEX'] = await this.indexerDb.createActionIndex(action);

                // Remove tokens from escrow
                escrows.push([matchInfo['GET_TICK'], -matchInfo['GET_AMOUNT'], matchInfo['GET_ADDRESS']]);
                escrows.push([swapInfo['GET_TICK'],  -swapInfo['GET_AMOUNT'],  swapInfo['GET_ADDRESS']]);

                // Credit tokens to addresses
                credits.push([matchInfo['GET_TICK'], matchInfo['GET_AMOUNT'], matchInfo['GET_ADDRESS']]);
                credits.push([swapInfo['GET_TICK'],  swapInfo['GET_AMOUNT'],  swapInfo['GET_ADDRESS']]);

                // Store the GET_ADDRESS and GET_TICK in addresses list
                this.util.addAddressTicker(matchInfo['GET_ADDRESS'], matchInfo['GET_TICK']);
                this.util.addAddressTicker(swapInfo['GET_ADDRESS'],  swapInfo['GET_TICK']);

                // Process any transaction ledger changes (credits / debits / escrows)
                await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits, escrows);

                // Create record of match in swap_matches table
                await this.indexerDb.createSwapMatch(data, swapInfo, matchInfo);

                // Update record in swaps table to change status (open->complete)
                await this.indexerDb.createSwapStatus(data['ACTION_INDEX'], swapInfo['ACTION_INDEX'],  'complete');
                await this.indexerDb.createSwapStatus(data['ACTION_INDEX'], matchInfo['ACTION_INDEX'], 'complete');

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