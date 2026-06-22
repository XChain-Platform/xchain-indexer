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
 * XChain Platform Action - LIST
 * 
 * This action creates a list of items for use in actions.
 * 
 * PARAMS:
 * - VERSION            -  Format Version
 * - TYPE               -  List type (1=TICK, 2=ADDRESS)
 * - ITEM               -  Any valid `TICK` or `ADDRESS`
 * - EDIT               -  Edit action (1=ADD, 2=REMOVE)
 * - LIST_ACTION_INDEX  -  `ACTION_INDEX` of existing `LIST`
 * 
 * FORMATS:
 * - 0 = Create LIST
 * - 1 = Edit LIST
 * 
 ********************************************************************/

class List {

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
        this.formats[0] = 'VERSION|TYPE|ITEM';
        this.formats[1] = 'VERSION|EDIT|LIST_ACTION_INDEX|ITEM';

        // Define array of list types (1=Tick, 2=Address)
        this.listTypes = [1,2];

        // Define array of edit types (1=Add, 2=Remove)
        this.editTypes = [1,2];
    }

    // Handle parsing the LIST transaction
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

        // Define some placeholders
        let type    = null;
        let edit    = {};
        let list    = [];
        let invalid = {};

        /*****************************************************************
         * FORMAT Validations
         ****************************************************************/

        // Validate TYPE
        if(!error && format==0 && !this.listTypes.includes(Number(data['TYPE'])))
            error = 'invalid: TYPE (unknown)';

        // Validate EDIT
        if(!error && format==1 && !this.editTypes.includes(Number(data['EDIT'])))
            error = 'invalid: EDIT (unknown)';

        // Parse in the list type (if any)
        if(!error && format==1)
            type = await this.indexerDb.getListType(data['LIST_ACTION_INDEX']);

        // Validate LIST_ACTION_INDEX
        if(!error && format==1 && type===false){
            error = 'invalid: LIST_ACTION_INDEX (unknown)';
            data['LIST_ACTION_INDEX'] = null;
        }

        // Lookup list information
        if(!error && format==1){
            data['TYPE'] = type;
            list         = await this.indexerDb.getList(data['LIST_ACTION_INDEX']);
        }

        /*****************************************************************
         * General Validations
         ****************************************************************/

        // Verify SOURCE is not sleeping
        if(!error && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
            error = 'invalid: SOURCE (sleeping)';

        // Handle building out some data arrays using list items
        if(!error){

            // Build out array of edit items and status for each
            for(let idx in params){
                let status = 'valid';
                let item   = params[idx];
                // Get list items
                if((format==0 && idx > 1)||(format==1 && idx > 2)){

                    // Verify TICK 
                    if(data['TYPE']==1){
                        let tokenInfo = await this.indexerDb.getTokenInfo(item);
                        if(!tokenInfo)
                            status = 'invalid: TICK (unknown)';
                    }

                    // Verify ADDRESS
                    if(data['TYPE']==2 && !this.util.isCryptoAddress(item))
                        status = 'invalid: ADDRESS (format)';

                    // Add item and status to edits array
                    edit[item] = status;
                }
            }

            // Build out final array of list items
            for(let item in edit){
                let status = edit[item];

                // VALID items
                if(status=='valid'){

                    // ADD items
                    if((format==0 || (format==1 && data['EDIT']==1)) && !list.includes(item))
                        list.push(item);

                    // REMOVE items
                    if(format==1 && data['EDIT']==2 && list.includes(item))
                        list.splice(list.indexOf(item),1);

                } else {
                    // INVALID items
                    invalid[item] = status;
                }
            }

        }

        // Determine final status
        let status = (error) ? error : 'valid';
        data['STATUS'] = status;

        // Print status message 
        console.log("\t LIST : " + data['STATUS']);

        // Create record in lists table
        await this.indexerDb.createList(data);

        // Store the SOURCE in addresses list
        this.util.addAddressTicker(data['SOURCE']);

        // If this was a valid transaction, then create the list and edit records
        if(status=='valid'){

            // Create record of edits and status for each
            for(let item in edit)
                await this.indexerDb.createListEdit(data, item, edit[item]);

            // Create record of items on list
            for(let item of list)
                await this.indexerDb.createListItem(data, item);

            // Create record of invalid list items
            for(let item in invalid)
                await this.indexerDb.createListItemInvalid(data, item, invalid[item]);
        }

        // Create action mappings
        await this.mapper.createMappings(data);

    }
}

module.exports = List;