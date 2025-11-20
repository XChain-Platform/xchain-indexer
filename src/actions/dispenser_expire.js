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
 * XChain Platform Action - DISPENSER_EXPIRE
 * 
 * This action processes dispensers that have expired
 *
 ********************************************************************/

class Dispenser_Expire {

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

    // Handle closing a dispenser
    async parse(params, data, error){

        // Get info on the dispenser
        let dispenserInfo = await this.indexerDb.getDispenserInfo(this.config['COIN'], data['ACTION_INDEX']);

        // Add SOURCE and GET_ADDRESS addresses and GET_TICK to addresses list
        this.util.addAddressTicker(dispenserInfo['SOURCE'], dispenserInfo['GIVE_TICK']);
        this.util.addAddressTicker(dispenserInfo['GET_ADDRESS'], dispenserInfo['GIVE_TICK']);

        // Define DISPENSER_CLOSE action
        let action = {}
        action['ACTION']      = 'DISPENSER_EXPIRE';
        action['STATUS']      = 'valid';
        action['BLOCK_INDEX'] = data['BLOCK_INDEX'];

        // Create a record of this DISPENSER_EXPIRE action in the actions table
        data['ACTION_INDEX'] = await this.indexerDb.createActionIndex(action);

        // Set the status to valid
        data['STATUS'] = 'valid';

        // Print status message
        console.log("\t DISPENSER_EXPIRE : " + this.config['COIN'] + ':' + dispenserInfo['ACTION_INDEX'] + ' : ' + data['STATUS']);

        // Array of credits, debits, and escrows
        let credits = [],
            debits  = [],
            escrows = [];

        // Debit GIVE_TICK from escrows and credit it to the SOURCE address
        escrows.push([dispenserInfo['GIVE_TICK'], -dispenserInfo['GIVE_REMAINING'], dispenserInfo['SOURCE']]);
        credits.push([dispenserInfo['GIVE_TICK'],  dispenserInfo['GIVE_REMAINING'], dispenserInfo['SOURCE']]);

        // Create record in the dispenser_expires table
        await this.indexerDb.createDispenserExpire(data['ACTION_INDEX'], dispenserInfo['ACTION_INDEX'], data['STATUS']);

        // Create record in the dispenser_statuses table
        await this.indexerDb.createDispenserStatus(data['ACTION_INDEX'], dispenserInfo['ACTION_INDEX'], 'expired');

        // Process any transaction ledger changes (credits / debits / escrows)
        await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits, escrows);

        // Get a list of addresses
        let addresses = Object.keys(this.util.getAddressesList());

        // Update address balances
        await this.indexerDb.updateBalances(addresses);

        // Create action mappings
        await this.mapper.createMappings(data);
    }
}

module.exports = Dispenser_Expire;