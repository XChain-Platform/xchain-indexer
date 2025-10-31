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

        // Clone the raw data into a order object
        let order = structuredClone(data);

        // Get information on a order given the COIN network and ORDER_ACTION_INDEX
        let orderIndex = (data['ORDER_ACTION_INDEX']) ? data['ORDER_ACTION_INDEX'] : data['ACTION_INDEX'];
        let orderInfo  = await this.indexerDb.getOrderInfo(this.config['COIN'], orderIndex)

        // Get a list of any matching open orders
        let matches = await this.indexerDb.findOrderMatches(orderInfo);
        if(matches){
            // Get information on the tokens involved in the order
            let getTokenInfo  = await this.indexerDb.getTokenInfo(orderInfo['GET_TICK'],  order['BLOCK_INDEX'], order['ACTION_INDEX']);
            let giveTokenInfo = await this.indexerDb.getTokenInfo(orderInfo['GIVE_TICK'], order['BLOCK_INDEX'], order['ACTION_INDEX']);

            // List of addresses allowed or blocked from holding GET_TICK
            let getTokenAllowList = (!this.util.isNull(getTokenInfo['ALLOW_LIST'])) ? await this.indexerDb.getList(getTokenInfo['ALLOW_LIST']) : false;
            let getTokenBlockList = (!this.util.isNull(getTokenInfo['BLOCK_LIST'])) ? await this.indexerDb.getList(getTokenInfo['BLOCK_LIST']) : false;

            // List of addresses allowed or blocked from holding GIVE_TICK
            let giveTokenAllowList = (!this.util.isNull(giveTokenInfo['ALLOW_LIST'])) ? await this.indexerDb.getList(giveTokenInfo['ALLOW_LIST']) : false;
            let giveTokenBlockList = (!this.util.isNull(giveTokenInfo['BLOCK_LIST'])) ? await this.indexerDb.getList(giveTokenInfo['BLOCK_LIST']) : false;

            // List of addresses allowed or blocked from matching with this ORDER
            let orderInfoAllowList = (!this.util.isNull(orderInfo['ALLOW_LIST'])) ? await this.indexerDb.getList(orderInfo['ALLOW_LIST']) : false;
            let orderInfoBlockList = (!this.util.isNull(orderInfo['BLOCK_LIST'])) ? await this.indexerDb.getList(orderInfo['BLOCK_LIST']) : false;

            // Loop through matches and determine if we have a valid match
            for(let match of matches){
                let valid = true;

                // List of addresses allowed or blocked from matching with this matching ORDER
                let matchInfoAllowList = (!this.util.isNull(match['ALLOW_LIST'])) ? await this.indexerDb.getList(match['ALLOW_LIST']) : false;
                let matchInfoBlockList = (!this.util.isNull(match['BLOCK_LIST'])) ? await this.indexerDb.getList(match['BLOCK_LIST']) : false;

                // Check if GET_ADDRESS for both sides of swap are allowed (ALLOW/BLOCK list support)
                if((getTokenAllowList.length  && (!getTokenAllowList.includes(orderInfo['GET_ADDRESS'])  || !getTokenAllowList.includes(match['GET_ADDRESS'])))  ||
                   (getTokenBlockList.length  && ( getTokenBlockList.includes(orderInfo['GET_ADDRESS'])  ||  getTokenBlockList.includes(match['GET_ADDRESS'])))  ||
                   (giveTokenAllowList.length && (!giveTokenAllowList.includes(orderInfo['GET_ADDRESS']) || !giveTokenAllowList.includes(match['GET_ADDRESS']))) ||
                   (giveTokenBlockList.length && ( giveTokenBlockList.includes(orderInfo['GET_ADDRESS']) ||  giveTokenBlockList.includes(match['GET_ADDRESS']))) ||
                   (orderInfoAllowList.length && !orderInfoAllowList.includes(match['GET_ADDRESS']))     ||
                   (orderInfoBlockList.length &&  orderInfoBlockList.includes(match['GET_ADDRESS']))     || 
                   (matchInfoAllowList.length && !matchInfoAllowList.includes(orderInfo['GET_ADDRESS'])) ||
                   (matchInfoBlockList.length &&  matchInfoBlockList.includes(orderInfo['GET_ADDRESS']))){
                    valid = false;
                }

                // TODO : Determine what the remaining amounts in escrow are

                // TODO: Add support for partial matches... currently only support exact matches

                // If we found a valid match, process the order match and update the escrowed amounts
                // TODO : Revisit this code once multi-chain order support is added to xchain-hub component
                if(valid){

                    // Create  alias for current matching order info
                    let matchInfo = match;

                    // Set the status to valid
                    data['STATUS'] = 'valid';

                    // Print status message
                    console.log("\t ORDER_MATCH : " + orderInfo['GIVE_AMOUNT'] + ' ' + orderInfo['GIVE_COIN'] + ':' + orderInfo['GIVE_TICK'] + ' = '  +  data['GET_AMOUNT'] + ' ' + data['GET_COIN'] + ':' + data['GET_TICK'] + ' : ' + data['STATUS']);

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

                    // Credit tokens to GET_ADDRESS in orders
                    credits.push([matchInfo['GET_TICK'], matchInfo['GET_AMOUNT'], matchInfo['GET_ADDRESS']]);
                    credits.push([orderInfo['GET_TICK'], orderInfo['GET_AMOUNT'], orderInfo['GET_ADDRESS']]);

                    // Debit tokens from escrows orders 
                    escrows.push([matchInfo['GET_TICK'], -matchInfo['GET_AMOUNT'], orderInfo['SOURCE']]);
                    escrows.push([orderInfo['GET_TICK'], -orderInfo['GET_AMOUNT'], matchInfo['SOURCE']]);

                    // Store the GET_ADDRESS and TICK in addresses list
                    this.util.addAddressTicker(matchInfo['GET_ADDRESS'], matchInfo['GET_TICK']);
                    this.util.addAddressTicker(orderInfo['GET_ADDRESS'], orderInfo['GET_TICK']);

                    // Process any transaction ledger changes (credits / debits / escrows)
                    await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits, escrows);

                    // Create record of match in order_matches table
                    await this.indexerDb.createOrderMatch(data, orderInfo, matchInfo);

                    // TODO verify if order still has some GET_TICK and GIVE_TICK quantity. if not, change status to filled
                    // Update record in orders table to change status (open->filled)
                    await this.indexerDb.createOrderStatus(data['ACTION_INDEX'], orderInfo['ACTION_INDEX'], 'filled');
                    await this.indexerDb.createOrderStatus(data['ACTION_INDEX'], matchInfo['ACTION_INDEX'], 'filled');
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