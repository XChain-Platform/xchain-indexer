/*********************************************************************
 * XChain Indexer ACTION - BATCH
 * 
 * PARAMS:
 * - VERSION - Broadcast Format Version
 * - COMMAND - Any valid ACTION with PARAMS
 * 
 * FORMATS:
 * - 0 = Full (VERSION|COMMAND;COMMAND)
 * 
 ********************************************************************/


class Batch {

    // Handle constructing a class instance
    constructor(action){
        // Parse in indexer configuration
        this.config    = action.config;

        // Setup alias to the indexer database connections
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;

        // Setup alias to utility class
        this.util     = action.util;

        // Setup alias to actions class
        this.actions  = action;

        // Setup alias to protocol changes class
        this.protocolChanges = action.changes;

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

        // Validate that format is known
        let format = this.util.getFormatVersion(params[0]);
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
            if(!error && !this.protocolChanges.isEnabled(action, data['BLOCK_INDEX']))
                error = 'invalid: ACTION (unknown)';
        }

        // Verify ACTION command limits
        for(let action in actions){
            if(!error && Object.keys(this.actionLimits).includes(action) && actions[action] > this.actionLimits[action])
                error = 'invalid: ' + action  + ' (limit)';
        }

        // Determine final status
        let status = (error) ? error : 'valid';
        data['STATUS'] = batch['STATUS'] = status;

        // Print status message 
        console.log("\t BATCH : " + data['SOURCE'] + ' : ' + data['STATUS']);

        // Create record in batches table
        await this.indexerDb.createBatch(batch);

        // Handle processing the specific ACTION commands
        if(status=='valid'){
            for(let command of commands){
                params     = String(command).split('|');
                let action = String(params.shift()).toUpperCase();
                data['ACTION']  = action;
                data['TX_DATA'] = command;
                await this.actions.processAction(action, params, data, error);
            }
        }
    }
}

module.exports = Batch;