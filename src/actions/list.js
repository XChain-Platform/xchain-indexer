/*********************************************************************
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
        // Setup alias to actions instance
        this.actions  = action;

        // Parse in indexer configuration
        this.config    = action.config;

        // Setup alias to the indexer database connections
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;

        // Setup alias to utility class
        this.util      = action.util;

        // Define list of known FORMATS
        this.formats = {};
        this.formats[0] = 'VERSION|TYPE|ITEM';
        this.formats[1] = 'VERSION|EDIT|LIST_ACTION_INDEX|ITEM';

        // Define array of list types (1=Tick, 2=Address)
        this.listTypes = [1,2];

        // Define array of edit types (1=Add, 2=Remove)
        this.editTypes = [1,2];

        // Define lists of various fields
        this.fieldList = {};

        // Define list of NUMBER fields (used to convert values from string to number)
        this.fieldList['NUMBER'] = ['TYPE', 'EDIT', 'LIST_ACTION_INDEX'];
    }

    // Handle parsing the LIST transaction
    async parse(params, data, error){
        /*****************************************************************
         * DEBUGGING - Force params
         ****************************************************************/
        // let str = "0|1|JDOG|BRRR|TEST";
        // let str = "0|2|1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev|1FWDonkMbC6hL64JiysuggHnUAw2CKWszs|1BTNSGASK5En7rFurDJ79LQ8CVYo2ecLC8";
        // let str = "1|2|860dc04b2b59657005a0955f282043c04bc9d5520562d317119722956043ffee|1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev|1FWDonkMbC6hL64JiysuggHnUAw2CKWszs";
        // let str = "1|1|b21f92568cf4f892fdf9adf432bfe1900ec41f16a1514c851b54926bd2828950|1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev|1FWDonkMbC6hL64JiysuggHnUAw2CKWszs|1FwkKA9cqpNRFTpVaokdRjT9Xamvebrwcu|bc1q50kxp76j9l0k9jgwasvcz4mcz0v03fv2y5pdxx|1Lfm6jXgCQi8LvjpgFHa2F4hdr1uJVa5t4";
        // params = String(str).split('|');

        // Validate that format is known
        let format = this.util.getFormatVersion(params[0]);
        if(!error && (format===null || this.formats[format] === undefined ))
            error = 'invalid: VERSION (unknown)';

        // Parse PARAMS using given VERSION format and update transaction data object
        if(!error)
            data = this.util.setActionParams(data, params, this.formats[format]);

        // Convert NUMBER fields from string value to number value so comparisons are mathematical 
        for(let name of this.fieldList['NUMBER']){
            let value = data[name];
            if(!this.util.isNull(value))
                data[name] = this.util.bcnum(value);
        }

        // Define some placeholders
        let type    = null;
        let edit    = {};
        let list    = [];
        let invalid = {};

        // DEBUG : Translate TYPE 3 (BTNS address) to 2 (XChain address)
        // TODO  : Remove this when done testing using old BTNS data
        if(data['TYPE']==3)
            data['TYPE'] = 2;

        /*****************************************************************
         * FORMAT Validations
         ****************************************************************/

        // Validate TYPE
        if(!error && format==0 && !this.listTypes.includes(data['TYPE']))
            error = 'invalid: TYPE (unknown)';

        // Validate EDIT
        if(!error && format==1 && !this.editTypes.includes(data['EDIT']))
            error = 'invalid: EDIT (unknown)';

        // Parse in the list type (if any)
        if(!error && format==1)
            type = await this.indexerDb.getListType(data['LIST_ACTION_INDEX']);

        // Validate LIST_ACTION_INDEX
        if(!error && format==1 && type===false)
            error = 'invalid: LIST_ACTION_INDEX (unknown)';

        // Lookup list information
        if(!error && format==1){
            data['TYPE'] = type;
            list         = await this.indexerDb.getList(data['LIST_ACTION_INDEX']);
        }

        /*****************************************************************
         * General Validations
         ****************************************************************/

        // Verify SOURCE is allowed to perform action
        if(!error && !await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']))
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

    }
}

module.exports = List;