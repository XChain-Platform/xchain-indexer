/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
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
        if(!error && !this.util.isNull(data['RESUME_BLOCK']) && !this.config['SLEEP_IMMEDIATE_METHODS'].includes(Number(data['RESUME_BLOCK'])) && this.util.bclt(data['RESUME_BLOCK'], data['BLOCK_INDEX']))
            error = 'invalid: RESUME_BLOCK (block_index)';

        // Verify SOURCE is not sleeping
        if(!error && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
            error = 'invalid: SOURCE (sleeping)';

        // Verify TICK sleep is being done by current TICK owner
        if(!error && data['TYPE']=='TICK' && data['SOURCE']!=tokenInfo['OWNER'])
            error = 'invalid: TICK (not authorized)';

        // Honor the token's LOCK_SLEEP flag. A token issued with LOCK_SLEEP=1 carries an immutable
        // "cannot be paused" guarantee (issue.js), so a TICK sleep of it must be rejected - the same
        // enforcement every other LOCK_* flag gets in its handler (LOCK_MINT in mint.js, LOCK_CALLBACK
        // in callback.js). Without it the owner can permanently freeze a token they promised never to
        // pause (SLEEP|1|-1|TICK -> isTickSleeping forever), stranding every holder's balance. Gated
        // (tightens validity): flips fleet-wide at one coordinated block; pre-launch chains at genesis.
        if(!error && data['TYPE']=='TICK' && tokenInfo && tokenInfo['LOCK_SLEEP']==1
           && await this.actions.protocolChanges.isEnabled('SLEEP_RESPECTS_LOCK_SLEEP', data['BLOCK_INDEX']))
            error = 'invalid: LOCK_SLEEP';

        // Reject if TICK ownership is currently escrowed by an open ORDER/SWAP/DISPENSER
        if(!error && data['TYPE']=='TICK' && await this.indexerDb.isOwnershipEscrowed(data['TICK']))
            error = 'invalid: TICK (ownership escrowed)';

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