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
 * XChain Platform Action - ORDER_MATCH
 * 
 * This action finds and processes matching order actions
 *
 ********************************************************************/

class Order_Match {

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

    // Handle looking for matching orders
    async parse(params, data, error){

        // Get information on a order given the COIN network and ORDER_ACTION_INDEX
        let orderIndex = (data['ORDER_ACTION_INDEX']) ? data['ORDER_ACTION_INDEX'] : data['ACTION_INDEX'];
        let orderInfo  = await this.indexerDb.getOrderInfo(this.config['COIN'], orderIndex)

        // Get a list of any matching open orders
        let matches = await this.indexerDb.getOrderMatches(data);
        // console.log('matches=',matches);
        if(matches){
            // Get information on the tokens involved in the order
            let getTokenInfo  = await this.indexerDb.getTokenInfo(data['GET_TICK'],  data['BLOCK_INDEX'], data['ACTION_INDEX']);
            let giveTokenInfo = await this.indexerDb.getTokenInfo(data['GIVE_TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX']);

            // List of addresses allowed or blocked from holding GET_TICK
            let getTokenAllowList = (getTokenInfo['ALLOW_LIST']) ? await this.indexerDb.getList(getTokenInfo['ALLOW_LIST']) : false;
            let getTokenBlockList = [getTokenInfo['BLOCK_LIST']] ? await this.indexerDb.getList(getTokenInfo['BLOCK_LIST']) : false;

            // List of addresses allowed or blocked from holding GIVE_TICK
            let giveTokenAllowList = (giveTokenInfo['ALLOW_LIST']) ? await this.indexerDb.getList(giveTokenInfo['ALLOW_LIST']) : false;
            let giveTokenBlockList = [giveTokenInfo['BLOCK_LIST']] ? await this.indexerDb.getList(giveTokenInfo['BLOCK_LIST']) : false;

            // List of addresses allowed or blocked from matching with this ORDER
            let orderInfoAllowList = (orderInfo['ALLOW_LIST']) ? await this.indexerDb.getList(orderInfo['ALLOW_LIST']) : false;
            let orderInfoBlockList = [orderInfo['BLOCK_LIST']] ? await this.indexerDb.getList(orderInfo['BLOCK_LIST']) : false;

            // Loop through matches and determine if we have a valid match
            let match = false;
            for(let order of matches){
                let valid = true;

               // List of addresses allowed or blocked from matching with this matching SWAP
               let matchInfoAllowList = (order['ALLOW_LIST']) ? await this.indexerDb.getList(order['ALLOW_LIST']) : false;
               let matchInfoBlockList = [order['BLOCK_LIST']] ? await this.indexerDb.getList(order['BLOCK_LIST']) : false;

                // Check if GET_ADDRESS for both sides of order are allowed (ALLOW/BLOCK list support)
                if( (getTokenAllowList.length  && (!getTokenAllowList.includes(data['GET_ADDRESS'])   || !getTokenAllowList.includes(order['GET_ADDRESS'])))  ||
                    (getTokenBlockList.length  && ( getTokenBlockList.includes(data['GET_ADDRESS'])   ||  getTokenBlockList.includes(order['GET_ADDRESS'])))  ||
                    (giveTokenAllowList.length && (!giveTokenAllowList.includes(data['GET_ADDRESS'])  || !giveTokenAllowList.includes(order['GET_ADDRESS']))) ||
                    (giveTokenBlockList.length && ( giveTokenBlockList.includes(data['GET_ADDRESS'])  ||  giveTokenBlockList.includes(order['GET_ADDRESS'])))  ||
                    (orderInfoAllowList.length && !orderInfoAllowList.includes(order['GET_ADDRESS'])) ||
                    (orderInfoBlockList.length &&  orderInfoBlockList.includes(order['GET_ADDRESS'])) || 
                    (matchInfoAllowList.length && !matchInfoAllowList.includes(data['GET_ADDRESS']))  ||
                    (matchInfoBlockList.length &&  matchInfoBlockList.includes(data['GET_ADDRESS']))){
                    valid = false;
                }

                // If we found a valid match, process the order match and update the escrowed amounts
                // TODO : Revisit this code once multi-chain order support is added to xchain-hub component
                if(valid){

                    // TODO: Add support for partial matches... currently only support exact matches

                    // Set the status to valid
                    data['STATUS'] = 'valid';

                    // Print status message
                    console.log("\t ORDER_MATCH : " + data['GIVE_AMOUNT'] + ' ' + this.config['COIN'] + ':' + data['GIVE_TICK'] + ' = '  +  data['GET_AMOUNT'] + ' ' + data['GET_COIN'] + ':' + data['GET_TICK'] + ' : ' + data['STATUS']);

                    // Pass forward information on this order match
                    match = order;

                    // Array of credits, debits, and escrows
                    let credits = [],
                        debits  = [],
                        escrows = [];


                    // Define ORDER_MATCH action
                    let action = {}
                    action['BLOCK_INDEX'] = data['BLOCK_INDEX'];
                    action['TX_INDEX']    = data['TX_INDEX']
                    action['ACTION']      = 'ORDER_MATCH';

                    // Create a record of this ORDER_MATCH action in the actions table
                    data['ACTION_INDEX'] = await this.indexerDb.createActionIndex(action);

                    // Store the SOURCE and GET_TICK in addresses list
                    this.util.addAddressTicker(match['SOURCE'], match['GET_TICK']);

                    // Credit tokens to GET_ADDRESS in orders
                    credits.push([match['GET_TICK'], match['GET_AMOUNT'], match['GET_ADDRESS']]);
                    credits.push([data['GET_TICK'],  data['GET_AMOUNT'],  data['GET_ADDRESS']]);

                    // Debit tokens from escrows table 
                    escrows.push([match['GET_TICK'], -match['GET_AMOUNT'], data['SOURCE']]);
                    escrows.push([data['GET_TICK'],  -data['GET_AMOUNT'],  match['SOURCE']]);

                    // Store the GET_ADDRESS and TICK in addresses list
                    this.util.addAddressTicker(match['GET_ADDRESS'], match['GET_TICK']);
                    this.util.addAddressTicker(data['GET_ADDRESS'],  data['GET_TICK']);

                    // Process any transaction ledger changes (credits / debits / escrows)
                    await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits, escrows);

                    // Create record of match in order_matches table
                    await this.indexerDb.createOrderMatch(data['ACTION_INDEX'], order, match, 'valid');

                    // TODO verify if order still has some GET_TICK and GIVE_TICK quantity. if not, change status to filled
                    // Update record in orders table to change status (open->filled)
                    await this.indexerDb.createOrderStatus(data['ACTION_INDEX'], order['ACTION_INDEX'], 'filled');
                    await this.indexerDb.createOrderStatus(data['ACTION_INDEX'], match['ACTION_INDEX'], 'filled');
                }
            }

            // Get a list of addresses
            let addresses = Object.keys(this.util.getAddressesList());

            // Update address balances
            await this.indexerDb.updateBalances(addresses);

            // Create action mappings
            await this.mapper.createMappings(data);

        }
    }
}

module.exports = Order_Match;