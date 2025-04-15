/*********************************************************************
 * XChain Platform Action - LINK
 * 
 * This action uploads a file including file metadata.
 * 
 * PARAMS:
 * - VERSION           - Format Version
 * - LINK_ACTION_INDEX - `ACTION_INDEX` of action
 * - COIN              - `COIN` name (BTC, LTC, DOGE, etc)
 * - COIN_ACTION_INDEX - `ACTION_INDEX` of action on `COIN` network
 * - MEMO              - An optional memo to include
 *
 * FORMATS:
 * - 0 = Full
 * 
 ********************************************************************/

class File {

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
        this.formats[0] = 'VERSION|LINK_ACTION_INDEX|COIN|COIN_ACTION_INDEX|MEMO';

        // Define lists of various fields
        this.fieldList = {};

        // Define list of NUMBER fields (used to convert values from string to number)
        this.fieldList['NUMBER'] = ['LINK_ACTION_INDEX', 'COIN_ACTION_INDEX'];

    }

    // Handle parsing the ADDRESS transaction
    async parse(params, data, error){
        /*****************************************************************
         * DEBUGGING - Force params
         ****************************************************************/
        // let str = "0|1234|BTC|4321|Linking FILE upload to TICK";
        // let str = "0|1234|DOGE|6666|Linking TICK with FILE upload on DOGE";
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

        /*****************************************************************
         * FORMAT Validations
         ****************************************************************/

        // Verify LINK_ACTION_INDEX format
        if(!error && (this.util.isNull(data['LINK_ACTION_INDEX']) || !this.util.isNumeric(data['LINK_ACTION_INDEX'])))
            error = 'invalid: LINK_ACTION_INDEX (format)';

        // Verify COIN_ACTION_INDEX format
        if(!error && (this.util.isNull(data['COIN_ACTION_INDEX']) || !this.util.isNumeric(data['COIN_ACTION_INDEX'])))
            error = 'invalid: COIN_ACTION_INDEX (format)';

        /*****************************************************************
         * General Validations
         ****************************************************************/

        // Verify LINK_ACTION_INDEX is valid
        if(!error && !this.indexerDb.isActionIndexValid(data['LINK_ACTION_INDEX']))
            error = 'invalid: LINK_ACTION_INDEX (status)';

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
        console.log("\t LINK : " + data['LINK_ACTION_INDEX'] + '->' + data['COIN_ACTION_INDEX'] + ' : ' + data['STATUS']);

        // Create record in links table
        await this.indexerDb.createLink(data);

    }
}

module.exports = File;