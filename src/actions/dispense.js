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
 * XChain Platform Action - DISPENSE
 * 
 * This action dispenses tokens from dispensers when they are triggered
  *
 ********************************************************************/

class Dispense {

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

    // Handle parsing the DISPENSE transaction
    async parse(params, data, error){

        // Save some details from the dispense request
        let block_index = data['BLOCK_INDEX'];
        let block_time  = data['BLOCK_TIME'];
        let tx_index    = data['TX_INDEX'];

        // Placeholder for valid dispenses
        let dispenses  = [];

        // Placeholder for dispenser info
        let dispenserInfo = {}; 

        // Lookup any dispensers that are triggered by this action
        let action_indexes = await this.indexerDb.findMatchingDispensers(data);

        // If we found no valid dispensers, delete the action_index that we created for this DISPENSE
        if(action_indexes.length==0)
            await this.indexerDb.deleteActionIndex(data['ACTION_INDEX']);

        // Loop through dispensers and generate a list of valid DISPENSE actions
        // Note: Dispense transactions which do not match an valid dispenser are ignored
        for(let action_index of action_indexes){

            // Reset the error to false for each dispenser
            let error = false;

            // Get full dispenser info including GIVE_REMAINING
            let dispenser = await this.indexerDb.getDispenserInfo(this.config['COIN'], action_index, data['BLOCK_TIME']);

            // Only proceed if we have a valid dispenser 
            if(!error && !dispenser)
                error = 'invalid: Dispenser unknown'

            // Store the dispenser info for easy reference
            if(!error)
                dispenserInfo[dispenser['ACTION_INDEX']] = dispenser;

            // FIAT dispenser: reverse price match to determine effective GET_AMOUNT
            // Two pricing modes:
            //   - With ORACLE_ADDRESS: use a user oracle (PRICE v1) for TOKEN/FIAT pricing.
            //     The oracle prices the dispensed token directly; FIAT_AMOUNT is ignored.
            //   - Without ORACLE_ADDRESS: use the validator COIN/FIAT snapshot (PRICE v0).
            //     FIAT_AMOUNT defines how much of the FIAT currency 1 GIVE unit costs.
            let multiplier = 0;
            if(!error && !this.util.isNull(dispenser['FIAT']) && !this.util.isNull(dispenser['ORACLE_ADDRESS'])){
                // User oracle path: combines PEPECASH/JPY (oracle) with BTC/JPY (validator) for cross-conversion
                let priceMatch = await this.util.reverseOraclePriceMatch(
                    data['COIN_AMOUNT'],
                    dispenser['ORACLE_ADDRESS'],
                    dispenser['GIVE_COIN'],
                    dispenser['GIVE_TICK'],
                    dispenser['FIAT'],
                    data['BLOCK_TIME'],
                    this.config['FIAT_DISPENSER_PRICE_WINDOW'],
                    this.indexerDb
                );
                if(priceMatch){
                    multiplier = priceMatch.units;
                } else {
                    error = 'invalid: no matching oracle price';
                }
            } else if(!error && !this.util.isNull(dispenser['FIAT'])){
                let coinPair = dispenser['GET_COIN'] + '/' + dispenser['FIAT'];
                let priceMatch = await this.util.reversePriceMatch(
                    data['COIN_AMOUNT'],
                    dispenser['FIAT_AMOUNT'],
                    coinPair,
                    data['BLOCK_TIME'],
                    this.config['FIAT_DISPENSER_PRICE_WINDOW'],
                    this.indexerDb
                );
                if(priceMatch){
                    multiplier = priceMatch.units;
                } else {
                    error = 'invalid: no matching price snapshot';
                }
            }

            // Non-FIAT dispenser: verify COIN_AMOUNT >= GET_AMOUNT and calculate multiplier
            if(!error && this.util.isNull(dispenser['FIAT'])){
                if(this.util.bclt(data['COIN_AMOUNT'], dispenser['GET_AMOUNT']))
                    error = 'invalid: GET_AMOUNT (insufficient funds)';
                if(!error)
                    multiplier = Math.floor(this.util.bcdiv(data['COIN_AMOUNT'], dispenser['GET_AMOUNT'], 64));
            }

            // Ignore if DISPENSE is being triggered by GET_ADDRESS (dispenser can't trigger itself)
            if(!error && data['SOURCE']==dispenser['GET_ADDRESS'])
                error = 'invalid: SOURCE and GET_ADDRESS can not be same';

            // Calculate how much to dispense based on the payment amount
            let give_amount = this.util.bcmul(multiplier, dispenser['GIVE_AMOUNT'], 64);

            // Give out the maximum amount allowed by the dispenser and payment amount
            while(multiplier > 0 && this.util.bcgt(give_amount, dispenser['GIVE_REMAINING'])){
                multiplier--;
                give_amount = this.util.bcmul(multiplier, dispenser['GIVE_AMOUNT'], 64);
            }

            // Verify that GIVE_AMOUNT 
            if(!error && multiplier == 0)
                error = 'invalid: insufficient funds ';

            // Only create dispensee if we are able to dispense at least 1 GIVE_AMOUNT
            if(!error){

                // Get information on the tokens involved in the dispense
                let getTokenInfo  = await this.indexerDb.getTokenInfo(dispenser['GET_TICK'],  data['BLOCK_INDEX'], data['ACTION_INDEX']);
                let giveTokenInfo = await this.indexerDb.getTokenInfo(dispenser['GIVE_TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX']);

                // List of addresses allowed or blocked from holding GET_TICK
                let getTokenAllowList = (getTokenInfo && !this.util.isNull(getTokenInfo['ALLOW_LIST'])) ? await this.indexerDb.getList(getTokenInfo['ALLOW_LIST']) : [];
                let getTokenBlockList = (getTokenInfo && !this.util.isNull(getTokenInfo['BLOCK_LIST'])) ? await this.indexerDb.getList(getTokenInfo['BLOCK_LIST']) : [];

                // List of addresses allowed or blocked from holding GIVE_TICK
                let giveTokenAllowList = (giveTokenInfo && !this.util.isNull(giveTokenInfo['ALLOW_LIST'])) ? await this.indexerDb.getList(giveTokenInfo['ALLOW_LIST']) : [];
                let giveTokenBlockList = (giveTokenInfo && !this.util.isNull(giveTokenInfo['BLOCK_LIST'])) ? await this.indexerDb.getList(giveTokenInfo['BLOCK_LIST']) : [];

                // List of addresses allowed or blocked from matching with this ORDER
                let dispenserAllowList = (!this.util.isNull(dispenser['ALLOW_LIST'])) ? await this.indexerDb.getList(dispenser['ALLOW_LIST']) : [];
                let dispenserBlockList = (!this.util.isNull(dispenser['BLOCK_LIST'])) ? await this.indexerDb.getList(dispenser['BLOCK_LIST']) : [];

                // Handle validating both sides of dispense are allowed (ALLOW/BLOCK list support)
                if(!error){
                    // Get Token Allow List
                    if(getTokenAllowList.length){
                        if(!error && !getTokenAllowList.includes(data['SOURCE']))
                            error = 'invalid: DESTINATION (GET_TOKEN allow list)';
                        if(!error && !getTokenAllowList.includes(dispenser['GET_ADDRESS']))
                            error = 'invalid: GET_ADDRESS (GET_TOKEN allow list)';
                    }
                    // Get Token Block List
                    if(getTokenBlockList.length){
                        if(!error && getTokenBlockList.includes(data['SOURCE']))
                            error = 'invalid: DESTINATION (GET_TOKEN block list)';
                        if(!error && getTokenBlockList.includes(dispenser['GET_ADDRESS']))
                            error = 'invalid: GET_ADDRESS (GET_TOKEN block list)';
                    }
                    // Give Token Allow List
                    if(giveTokenAllowList.length){
                        if(!error && !giveTokenAllowList.includes(data['SOURCE']))
                            error = 'invalid: DESTINATION (GIVE_TOKEN allow list)';
                        if(!error && !giveTokenAllowList.includes(dispenser['GET_ADDRESS']))
                            error = 'invalid: GET_ADDRESS (GIVE_TOKEN allow list)';
                    }
                    // Give Token Block List
                    if(giveTokenBlockList.length){
                        if(!error && giveTokenBlockList.includes(data['SOURCE']))
                            error = 'invalid: DESTINATION (GIVE_TOKEN block list)';
                        if(!error && giveTokenBlockList.includes(dispenser['GET_ADDRESS']))
                            error = 'invalid: GET_ADDRESS (GIVE_TOKEN block list)';
                    }
                    // Dispenser Allow List
                    if(dispenserAllowList.length){
                        if(!error && !dispenserAllowList.includes(data['SOURCE']))
                            error = 'invalid: DESTINATION (dispenser allow list)';
                        if(!error && !dispenserAllowList.includes(dispenser['GET_ADDRESS']))
                            error = 'invalid: GET_ADDRESS (dispenser allow list)';
                    }
                    // Dispenser Block List
                    if(dispenserBlockList.length){
                        if(!error && dispenserBlockList.includes(data['SOURCE']))
                            error = 'invalid: DESTINATION (DISPENSER block list)';
                        if(!error && dispenserBlockList.includes(dispenser['GET_ADDRESS']))
                            error = 'invalid: GET_ADDRESS (DISPENSER block list)';
                    }
                }
            }

            // Add the dispense info to the dispenses array;
            dispenses.push({
                DISPENSER_ACTION_INDEX: action_index,
                GIVE_COIN:              dispenser['GIVE_COIN'],
                GIVE_TICK:              dispenser['GIVE_TICK'],
                GIVE_AMOUNT:            give_amount,
                GET_COIN:               dispenser['GET_COIN'],
                GET_TICK:               dispenser['GET_TICK'],
                GET_AMOUNT:             data['COIN_AMOUNT'],
                DESTINATION:            data['SOURCE'],
                STATUS:                 error
            });
        }

        // Loop through dispenses and process each
        for(let idx in dispenses){

            // Reset the address/tickers/transactions list on each parse
            this.util.resetLists();

            // Store info on the dispense and dispenser
            let dispense  = dispenses[idx];
            let dispenser = dispenserInfo[dispense['DISPENSER_ACTION_INDEX']];

            // Add Addresses and ticks to the addresses list
            this.util.addAddressTicker(dispense['DESTINATION'], dispenser['GIVE_TICK']);
            this.util.addAddressTicker(dispenser['GET_ADDRESS'],dispenser['GET_TICK']);

            // Set flag to determine if we create new ACTION_INDEX or use existing one
            // Note: Use existing ACTION_INDEX for first DISPSENSE on a native COIN trigger (BTC, LTC. DOGE)
            let createActionIndex = (idx==0 && !this.util.isNull(data['ACTION_INDEX'])) ? false : true;

            // Create a record of this DISPENSE action in the actions table (if it does not already exist)
            dispense['ACTION_INDEX'] = (createActionIndex) ? await this.indexerDb.createActionIndex(data, true) : data['ACTION_INDEX'];

            // Update GIVE_REMAINING amount
            dispenser['GIVE_REMAINING'] = this.util.bcsub(dispenser['GIVE_REMAINING'], dispense['GIVE_AMOUNT'], 64);

            // Determine final status
            let error  = (dispense['STATUS']) ? dispense['STATUS'] : false;
            let status = (error) ? error : 'valid';
            dispense['STATUS'] = status;

            // Print status message
            console.log("\t DISPENSE : " + dispense['GIVE_AMOUNT'] + ' ' + dispenser['GIVE_TICK'] + ' : ' + dispense['STATUS']);

            // Create record in the dispenses table
            await this.indexerDb.createDispense(dispense);

            // Process the dispense
            if(status=='valid'){

                // Array of credits, debits, and escrows
                let credits = [],
                    debits  = [],
                    escrows = [];

                // Debit GIVE_TICK from escrows and credit it to the SOURCE address
                if(this.util.bcgt(dispense['GIVE_AMOUNT'], 0)){
                    escrows.push([dispense['GIVE_TICK'], -dispense['GIVE_AMOUNT'], dispense['DESTINATION']]);
                    credits.push([dispense['GIVE_TICK'],  dispense['GIVE_AMOUNT'], dispense['DESTINATION']]);
                }

                // Process any transaction ledger changes (credits / debits / escrows)
                await this.util.processTransactionLedgerChanges(this.indexerDb, dispense, credits, debits, escrows);

            }

            // Get a list of addresses
            let addresses = Object.keys(this.util.getAddressesList());

            // Update address balances
            await this.indexerDb.updateBalances(addresses);

            // Create action mappings
            await this.mapper.createMappings(dispense);

            // Close the dispenser if GIVE_REMAINING is less than GIVE_AMOUNT
            if(status=='valid' && this.util.bclt(dispenser['GIVE_REMAINING'], dispense['GIVE_AMOUNT'])){
                let action = 'DISPENSER_CLOSE';
                let data = {};
                data['ACTION']                 = action;
                data['BLOCK_INDEX']            = block_index;
                data['BLOCK_TIME']             = block_time;
                data['TX_INDEX']               = tx_index;
                data['DISPENSER_ACTION_INDEX'] = dispenser['ACTION_INDEX'];
                data['DISPENSER_STATUS']       = 'empty';
                await this.actions.processAction(action, null, data, null);
            }                    
        }
    }
}

module.exports = Dispense;