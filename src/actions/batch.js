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
 * XChain Platform Action - BATCH
 * 
 * This action batch executes multiple `ACTION` commands in a single transaction
 * 
 * PARAMS:
 * - VERSION - Format Version
 * - COMMAND - Any valid `ACTION` with `PARAMS`
 * 
 * FORMATS:
 * - 0 = Full (VERSION|COMMAND;COMMAND)
 * 
 ********************************************************************/


class Batch {

    // Handle constructing a class instance
    constructor(action){
        // Setup short aliases
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;

        // Setup alias to protocol changes class
        this.protocolChanges = action.protocolChanges;

        // Define list of known FORMATS
        this.formats = {};
        this.formats[0] = 'VERSION|COMMAND';

        // Define list of ACTIONS and usage limits
        this.actionLimits = {};
        this.actionLimits['BATCH'] = 0;
        this.actionLimits['MINT']  = 1;
        this.actionLimits['ISSUE'] = 1;
    }

    // Handle parsing the BATCH transaction
    async parse(params, data, error){
        // Clone the raw data for storage in batches table
        let batch = structuredClone(data);

        // Define list of ACTIONS and count of usage within BATCH
        let actions = {};

        /*****************************************************************
         * DEBUGGING - Force params
         ****************************************************************/
        // data['TX_DATA'] = "BATCH|0|MINT|0|GAS|60;ISSUE|0|JDOGTEST";
        // params = String(str).split('|');
        // data['FORMAT'] = this.util.getFormatVersion(params[0]);

        // Validate that format is known
        let format = data['FORMAT'];
        if(!error && (format===null || this.formats[format] === undefined ))
            error = 'invalid: VERSION (unknown)';

        // Get list of commands
        let commands = String(data['TX_DATA']).split(';');
        if(!error && (this.util.isNull(commands) || commands.length < 1)){
            error = 'invalid: COMMAND (unknown)';
        } else {
            // Trim BATCH and format VERSION from first command
            commands[0] = commands[0].replace('BATCH|' + format + '|','');
        }

        // Build out array of ACTIONs and count of times used in BATCH
        for(let command of commands){
            let action = String(command).split('|')[0];
            if(this.util.isNull(actions[action]))
                actions[action] = 0;
            actions[action]++;
        }

        /*****************************************************************
         * General Validations
         ****************************************************************/

        // Verify all ACTION commands are valid
        for(let command of commands){
            let action = String(command).split('|')[0];
            if(!error && await this.protocolChanges.isEnabled(action, data['BLOCK_INDEX']) == false)
                error = 'invalid: ACTION (unknown)';
        }

        // Verify ACTION command limits
        for(let action in actions){
            if(!error && Object.keys(this.actionLimits).includes(action) && actions[action] > this.actionLimits[action])
                error = 'invalid: ' + action  + ' (limit)';
        }

        // Verify SOURCE is allowed to perform action
        if(!error && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
            error = 'invalid: SOURCE (sleeping)';

        // Determine final status
        let status = (error) ? error : 'valid';
        data['STATUS'] = batch['STATUS'] = status;

        // Print status message 
        console.log("\t BATCH : " + data['SOURCE'] + ' : ' + data['STATUS']);

        // Create record in batches table
        await this.indexerDb.createBatch(batch);

        // Store the SOURCE in addresses list
        this.util.addAddressTicker(data['SOURCE']);

        // Create action mappings
        await this.mapper.createMappings(data);
        
        // Handle processing the specific ACTION commands
        if(status=='valid'){
            for(let command of commands){

                // Parse command into params
                params = String(command).split('|');

                // Extract ACTION from params
                let action = String(params.shift()).toUpperCase();

                // Update ACTION transaction data object
                data['ACTION']  = action;
                data['TX_DATA'] = command;

                // Increase the action index for every command
                data['ACTION_INDEX']++

                // Create a record of this action in the actions table
                data['ACTION_INDEX'] = await this.indexerDb.createActionIndex(data);

                // Process the specific ACTION commands
                await this.actions.processAction(action, params, data, error);
            }
        }
    }
}

module.exports = Batch;