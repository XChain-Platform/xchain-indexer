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
 * XChain Platform Action - SLEEP
 * 
 * This action pauses actions on an `ADDRESS` or a `TICK` until `RESUME_BLOCK` is reached.
 * 
 * PARAMS:
 * - VERSION      - Format Version
 * - TICK         - Ticker name or Ticker ID
 * - RESUME_BLOCK - Block index to resume actions
 * - MEMO         - An optional memo to include  
 *
 * FORMATS:
 * - 0 = Sleep `ADDRESS`
 * - 1 = Sleep `TICK`
 * 
 ********************************************************************/

class Sleep {

    // Handle constructing a class instance
    constructor(action){
        // Setup short aliases
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;
        
        // Define list of known FORMATS
        this.formats = {};
        this.formats[0] = 'VERSION|RESUME_BLOCK|MEMO';
        this.formats[1] = 'VERSION|RESUME_BLOCK|TICK|MEMO';
    }

    // Handle parsing the ADDRESS transaction
    async parse(params, data, error){
        /*****************************************************************
         * DEBUGGING - Force params
         ****************************************************************/
        // let str = "0|791495|Pausing actions until block 791495";
        // let str = "1|791495|JDOG|Pausing actions on JDOG until block 791495";
        // params = String(str).split('|');
        // data['FORMAT'] = this.util.getFormatVersion(params[0]);

        // Validate that format is known
        let format = data['FORMAT'];
        if(!error && (format===null || this.formats[format] === undefined ))
            error = 'invalid: VERSION (unknown)';

        // Parse PARAMS using given VERSION format and update transaction data object
        if(!error)
            data = this.util.setActionParams(data, params, this.formats, format);

        // Convert NUMBER fields from string value to number value so comparisons are mathematical 
        if(!error)
            data = this.util.setNumberFormats(data);

        // Get information on token (if any)
        let tokenInfo = await this.indexerDb.getTokenInfo(data['TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX']);

        // Set sleep type based off data format
        data['TYPE'] = (format==1) ? 'TICK' : 'ADDRESS';

        /*****************************************************************
         * TICK Validations
         ****************************************************************/

        // Validate TICK exists
        if(!error && data['TYPE']=='TICK' && !tokenInfo)
            error = 'invalid: TICK (unknown)';

        /*****************************************************************
         * FORMAT Validations
         ****************************************************************/

        // Verify RESUME_BLOCK format
        if(!error && (this.util.isNull(data['RESUME_BLOCK']) || !this.util.isNumeric(data['RESUME_BLOCK'])))
            error = 'invalid: RESUME_BLOCK (format)';

        /*****************************************************************
         * General Validations
         ****************************************************************/

        // Verify RESUME_BLOCK is now, in the future, or a special immediate method 
        if(!error && !this.util.isNull(data['RESUME_BLOCK']) && !this.config['SLEEP_IMMEDIATE_METHODS'].includes(data['RESUME_BLOCK']) && data['RESUME_BLOCK'] < data['BLOCK_INDEX'])
            error = 'invalid: RESUME_BLOCK (block_index)';

        // Verify SOURCE is allowed to perform action
        if(!error && !await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']))
            error = 'invalid: SOURCE (sleeping)';

        // Verify TICK sleep is being done by current TICK owner
        if(!error && data['TYPE']=='TICK' && data['SOURCE']!=tokenInfo['OWNER'])
            error = 'invalid: TICK (not authorized)';

        // Verify no pipe in MEMO (pipe is field delimiter)
        if(!error && String(data['MEMO']).indexOf('|')!=-1)
            error = 'invalid: MEMO (pipe)';

        // Verify no semicolon in MEMO (semicolon is action delimiter)
        if(!error && String(data['MEMO']).indexOf(';')!=-1)
            error = 'invalid: MEMO (semicolon)';

        // Verify MEMO is shorter than MAX_MEMO_LENGTH
        if(!error && String(data['MEMO']).length > this.config['MAX_MEMO_LENGTH'])
            error = 'invalid: MEMO (length)';

        // Determine final status
        let status = (error) ? error : 'valid';
        data['STATUS'] = status;

        // Print status message 
        console.log("\t SLEEP : " + data['TICK'] + ' : ' + data['RESUME_BLOCK'] + ' : ' + data['STATUS']);

        // Create record in messages table
        await this.indexerDb.createSleep(data);

        // Store the SOURCE and TICK in addresses list
        this.util.addAddressTicker(data['SOURCE'], data['TICK']);

        // Create action mappings
        await this.mapper.createMappings(data);        

    }
}

module.exports = Sleep;