/*********************************************************************
 * XChain Platform Action - FILE
 * 
 * This action uploads a file including file metadata.
 * 
 * PARAMS:
 * - VERSION - Format Version
 * - NAME    - Name of the file
 * - TYPE    - MIME Type of the file      
 * - TITLE   - Title of the file          
 * - MEMO    - An optional memo to include
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
        this.formats[0] = 'VERSION|NAME|TYPE|TITLE|MEMO';

    }

    // Handle parsing the ADDRESS transaction
    async parse(params, data, error){
        /*****************************************************************
         * DEBUGGING - Force params
         ****************************************************************/
        // let str = "0|test.txt|text/plain|Test File|This is a test upload";
        // let str = "0|xchain.jpg|image/jpeg|XChain Logo|This is the official XChain Logo";
        // params = String(str).split('|');

        // Validate that format is known
        let format = this.util.getFormatVersion(params[0]);
        if(!error && (format===null || this.formats[format] === undefined ))
            error = 'invalid: VERSION (unknown)';

        // Parse PARAMS using given VERSION format and update transaction data object
        if(!error)
            data = this.util.setActionParams(data, params, this.formats[format]);

        /*****************************************************************
         * General Validations
         ****************************************************************/

        // Verify SOURCE is allowed to perform action
        if(!error && !await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']))
            error = 'invalid: SOURCE (sleeping)';

        // Verify NAME is shorter than MAX_FILE_NAME_LENGTH
        if(!error && String(data['NAME']).length > this.config['MAX_FILE_NAME_LENGTH'])
            error = 'invalid: NAME (length)';

        // Verify TYPE is shorter than MAX_FILE_NAME_LENGTH
        if(!error && String(data['TYPE']).length > this.config['MAX_FILE_TYPE_LENGTH'])
            error = 'invalid: TYPE (length)';

        // Verify TITLE is shorter than MAX_FILE_NAME_LENGTH
        if(!error && String(data['TITLE']).length > this.config['MAX_FILE_TITLE_LENGTH'])
            error = 'invalid: TITLE (length)';

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
        console.log("\t FILE : " + data['NAME'] + ' : ' + data['TYPE'] + ' : ' + data['STATUS']);

        // Create record in files table
        await this.indexerDb.createFile(data);

    }
}

module.exports = File;