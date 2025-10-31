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

        // Flag to print debugging messages to the console
        this.debug = true;
    }

    // Handle looking for matching orders
    async parse(params, data, error){

        // Clone the raw data into a order object
        let order = structuredClone(data);

        // Placeholder to store match info (get/give remaining amounts)
        let match = {};

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

            // Set get/give remaining amounts for this order
            order['GIVE_REMAINING'] = orderInfo['GIVE_REMAINING'];
            order['GET_REMAINING']  = orderInfo['GET_REMAINING'];

            // Display initial get/give remaining amounts
            if(this.debug)
                console.log('ORDER - GET / GIVE remaining=',order['GIVE_REMAINING'],order['GET_REMAINING'])

            // Loop through matches and determine if we have a valid match
            for(let matchInfo of matches){

                // Set get/give remaining amounts for this order match
                match['GIVE_REMAINING'] = matchInfo['GIVE_REMAINING'];
                match['GET_REMAINING']  = matchInfo['GET_REMAINING'];

                // Ignore if we have nothing left to GIVE
                if(match['GIVE_REMAINING'] <= 0 || order['GIVE_REMAINING'] <= 0){
                    if(this.debug)
                        console.log('Skipping: negative GIVE quantity remaining ', match['GIVE_REMAINING'], order['GIVE_REMAINING']);
                    continue;
                }

                // Ignore if we have nothing left to GET
                if(match['GET_REMAINING'] <= 0 || order['GET_REMAINING'] <= 0){
                    if(this.debug)
                        console.log('Skipping: negative GET quantity remaining ', match['GET_REMAINING'], order['GET_REMAINING']);
                    continue;
                }

                // Ignore price mismatches
                if(matchInfo['GET_PRICE'] > orderInfo['GIVE_PRICE']){
                    if(this.debug)
                        console.log('Skipping due to price mismatch ', matchInfo['GET_PRICE'], orderInfo['GIVE_PRICE']);
                    continue;
                }

                // TODO: Pay attention to divisible and non-divisible tokens

                // Calculate the give and get amounts for this order match
                let give_amount = this.util.bcmul(matchInfo['GIVE_REMAINING'], orderInfo['GET_PRICE']),
                    get_amount  = this.util.bcmul(give_amount, orderInfo['GIVE_PRICE']);

                // Ignore zero quantity GIVE
                if(give_amount <= 0){
                    if(this.debug)
                        console.log('Skipping zero quantity GIVE amount ', give_amount);
                    continue;
                }

                // Ignore zero quantity GET
                if(give_amount <= 0){
                    if(this.debug)
                        console.log('Skipping zero quantity GET amount ', get_amount);
                    continue;
                }

                // List of addresses allowed or blocked from matching with this matching ORDER
                let matchInfoAllowList = (!this.util.isNull(matchInfo['ALLOW_LIST'])) ? await this.indexerDb.getList(matchInfo['ALLOW_LIST']) : false;
                let matchInfoBlockList = (!this.util.isNull(matchInfo['BLOCK_LIST'])) ? await this.indexerDb.getList(matchInfo['BLOCK_LIST']) : false;

                // Check if GET_ADDRESS for both sides of swap are allowed (ALLOW/BLOCK list support)
                if((getTokenAllowList.length  && (!getTokenAllowList.includes(orderInfo['GET_ADDRESS'])  || !getTokenAllowList.includes(matchInfo['GET_ADDRESS'])))  ||
                   (getTokenBlockList.length  && ( getTokenBlockList.includes(orderInfo['GET_ADDRESS'])  ||  getTokenBlockList.includes(matchInfo['GET_ADDRESS'])))  ||
                   (giveTokenAllowList.length && (!giveTokenAllowList.includes(orderInfo['GET_ADDRESS']) || !giveTokenAllowList.includes(matchInfo['GET_ADDRESS']))) ||
                   (giveTokenBlockList.length && ( giveTokenBlockList.includes(orderInfo['GET_ADDRESS']) ||  giveTokenBlockList.includes(matchInfo['GET_ADDRESS']))) ||
                   (orderInfoAllowList.length && !orderInfoAllowList.includes(matchInfo['GET_ADDRESS'])) ||
                   (orderInfoBlockList.length &&  orderInfoBlockList.includes(matchInfo['GET_ADDRESS'])) || 
                   (matchInfoAllowList.length && !matchInfoAllowList.includes(orderInfo['GET_ADDRESS'])) ||
                   (matchInfoBlockList.length &&  matchInfoBlockList.includes(orderInfo['GET_ADDRESS']))){
                    if(this.debug)
                        console.log('Skipping match due to allow/block list');
                    continue;
                }

                // Update GET_REMAINING and GIVE_REMAINING in the orders
                order['GIVE_REMAINING'] = this.util.bcsub(order['GIVE_REMAINING'], give_amount);
                order['GET_REMAINING']  = this.util.bcsub(order['GET_REMAINING'],  get_amount);
                match['GIVE_REMAINING'] = this.util.bcsub(match['GIVE_REMAINING'], get_amount);
                match['GET_REMAINING']  = this.util.bcsub(match['GET_REMAINING'],  give_amount);

                // Display get/give remaining amounts
                if(this.debug)
                    console.log('MATCH - GET / GIVE remaining=',order['GIVE_REMAINING'],order['GET_REMAINING'])

                // TODO : Revisit this code once multi-chain order support is added to xchain-hub component
                // Set the status to valid
                data['STATUS'] = 'valid';

                // Print status message
                console.log("\t ORDER_MATCH : " + give_amount + ' ' + orderInfo['GIVE_COIN'] + ':' + orderInfo['GIVE_TICK'] + ' = '  + get_amount + ' ' + data['GET_COIN'] + ':' + data['GET_TICK'] + ' : ' + data['STATUS']);

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
                credits.push([matchInfo['GET_TICK'], get_amount, matchInfo['GET_ADDRESS']]);
                credits.push([orderInfo['GET_TICK'], give_amount,  orderInfo['GET_ADDRESS']]);

                // // Debit tokens from escrows orders 
                escrows.push([matchInfo['GET_TICK'], -get_amount, orderInfo['SOURCE']]);
                escrows.push([orderInfo['GET_TICK'], -give_amount, matchInfo['SOURCE']]);

                // Store the GET_ADDRESS and TICK in addresses list
                this.util.addAddressTicker(matchInfo['GET_ADDRESS'], matchInfo['GET_TICK']);
                this.util.addAddressTicker(orderInfo['GET_ADDRESS'], orderInfo['GET_TICK']);

                // Process any transaction ledger changes (credits / debits / escrows)
                await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits, escrows);

                // Create record of match in order_matches table
                await this.indexerDb.createOrderMatch(data, orderInfo, matchInfo);

                // Handle marking the orders as 'complete' if we have nothing left to give or get
                if(order['GET_REMAINING'] <= 0 || order['GIVE_REMAINING'] <= 0)
                    await this.indexerDb.createOrderStatus(data['ACTION_INDEX'], orderInfo['ACTION_INDEX'], 'complete');
                if(match['GET_REMAINING'] <= 0 || match['GIVE_REMAINING'] <= 0)
                    await this.indexerDb.createOrderStatus(data['ACTION_INDEX'], matchInfo['ACTION_INDEX'], 'complete');


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