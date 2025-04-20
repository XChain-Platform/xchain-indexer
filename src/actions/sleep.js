/*********************************************************************
 * XChain Platform Action - SLEEP
 * 
 * This action pauses actions on an `ADDRESS` or a `TICK` until `RESUME_BLOCK` is reached.
 * 
 * PARAMS:
 * - VERSION      - Format Version
 * - TICK         - 1 to 250 characters in length
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
        // Parse in indexer configuration
        this.config    = action.config;

        // Setup alias to the indexer database connections
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;

        // Setup alias to utility class
        this.util = action.util;

        // Define list of known FORMATS
        this.formats = {};
        this.formats[0] = 'VERSION|RESUME_BLOCK|MEMO';
        this.formats[1] = 'VERSION|RESUME_BLOCK|TICK|MEMO';

        // Define lists of various fields
        this.fieldList = {};

        // Define list of NUMBER fields (used to convert values from string to number)
        this.fieldList['NUMBER'] = ['RESUME_BLOCK'];

    }

    // Handle parsing the ADDRESS transaction
    async parse(params, data, error){
        /*****************************************************************
         * DEBUGGING - Force params
         ****************************************************************/
        // let str = "0|791495|Pausing actions until block 791495";
        // let str = "1|791495|JDOG|Pausing actions on JDOG until block 791495";
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
            if(!this.util.isNull(value) && this.util.isNumeric(value))
                data[name] = this.util.bcnum(value);
        }

        // Get information on token (if any)
        let tokenInfo = await this.indexerDb.getTokenInfo(data['TICK'], null, data['BLOCK_INDEX'], data['ACTION_INDEX']);

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

    }
}

module.exports = Sleep;