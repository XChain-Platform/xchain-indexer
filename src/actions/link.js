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
 * XChain Platform Action - LINK
 * 
 * This action links actions using `ACTION_INDEX`, including linking actions across blockchains
 * 
 * PARAMS:
 * - VERSION            - Format Version
 * - COIN1              - `COIN` name (BTC, LTC, DOGE, etc)
 * - COIN1_ACTION_INDEX - `ACTION_INDEX` of action on `COIN1` network
 * - COIN2              - `COIN` name (BTC, LTC, DOGE, etc)
 * - COIN2_ACTION_INDEX - `ACTION_INDEX` of action on `COIN2` network
 * - MEMO               - An optional memo to include
 *
 * FORMATS:
 * - 0 = Full
 * 
 ********************************************************************/

class Link {

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
        this.formats[0] = 'VERSION|COIN1|COIN1_ACTION_INDEX|COIN2|COIN2_ACTION_INDEX|MEMO';
    }

    // Handle parsing the ADDRESS transaction
    async parse(params, data, error){
        /*****************************************************************
         * DEBUGGING - Force params
         ****************************************************************/
        // let str = "0|1234|BTC|4321|Linking FILE upload to TICK";
        // let str = "0|1234|DOGE|6666|Linking TICK with FILE upload on DOGE";
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

        /*****************************************************************
         * COIN Validations
         ****************************************************************/

        // Validate COIN1 is valid
        if(!error && format==0 && !this.config['COINS'].includes(data['COIN1']))
            error = 'invalid: COIN1 (unsupported COIN network)';

        // Validate COIN2 is valid
        if(!error && format==0 && !this.config['COINS'].includes(data['COIN2']))
            error = 'invalid: COIN2 (unsupported COIN network)';

        /*****************************************************************
         * FORMAT Validations
         ****************************************************************/

        // Verify COIN1_ACTION_INDEX format
        if(!error && (this.util.isNull(data['COIN1_ACTION_INDEX']) || !this.util.isNumeric(data['COIN1_ACTION_INDEX'])))
            error = 'invalid: COIN1_ACTION_INDEX (format)';

        // Verify COIN2_ACTION_INDEX format
        if(!error && (this.util.isNull(data['COIN2_ACTION_INDEX']) || !this.util.isNumeric(data['COIN2_ACTION_INDEX'])))
            error = 'invalid: COIN2_ACTION_INDEX (format)';

        /*****************************************************************
         * General Validations
         ****************************************************************/

        // Verify SOURCE is not sleeping
        if(!error && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
            error = 'invalid: SOURCE (sleeping)';

        // Verify COIN1_ACTION_INDEX is valid (only validate links on current COIN network)
        if(!error && data['COIN1']==this.config['COIN'] && await this.indexerDb.isActionIndexValid(data['COIN1_ACTION_INDEX']) == false)
            error = 'invalid: COIN1_ACTION_INDEX (status)';

        // Verify COIN2_ACTION_INDEX is valid (only validate links on current COIN network)
        if(!error && data['COIN2']==this.config['COIN'] && await this.indexerDb.isActionIndexValid(data['COIN2_ACTION_INDEX']) == false)
            error = 'invalid: COIN2_ACTION_INDEX (status)';

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
        console.log("\t LINK : " + data['COIN1'] + ':' + data['COIN1_ACTION_INDEX'] + '->' + data['COIN2'] + ':' + data['COIN2_ACTION_INDEX'] + ' : ' + data['STATUS']);

        // Create record in links table
        await this.indexerDb.createLink(data);

        // Store the SOURCE in addresses list
        this.util.addAddressTicker(data['SOURCE']);

        // Create action mappings
        await this.mapper.createMappings(data);

    }
}

module.exports = Link;