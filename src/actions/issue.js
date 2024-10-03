/*********************************************************************
 * XChain Indexer ACTION - ISSUE
 * 
 * PARAMS:
 * - VERSION          - Broadcast Format Version
 * - TICK             - 1 to 250 characters in length
 * - MAX_SUPPLY       - Maximum token supply 
 * - MAX_MINT         - Maximum amount of supply a `MINT` transaction can issue
 * - DECIMALS         - Number of decimal places token should have (max: 18, default: 0)
 * - DESCRIPTION      - Description of token (250 chars max) 
 * - MINT_SUPPLY      - Amount of token supply to mint in immediately (default:0)
 * - TRANSFER         - Address to transfer ownership of the `token` to (owner can perform future actions on token)
 * - TRANSFER_SUPPLY  - Address to transfer `MINT_SUPPLY` to (mint initial supply and transfer to address)
 * - LOCK_MAX_SUPPLY  - Lock `MAX_SUPPLY` permanently (cannot increase `MAX_SUPPLY`)
 * - LOCK_MINT        - Lock `token` against `MINT` command
 * - LOCK_MAX_MINT    - Lock `MAX_MINT` permanently (cannot edit `MAX_MINT`)
 * - LOCK_DESCRIPTION - Lock `token` against `DESCRIPTION` changes
 * - LOCK_RUG         - Lock `token` against `RUG` command
 * - LOCK_SLEEP       - Lock `token` against `SLEEP` command
 * - LOCK_CALLBACK    - Lock `token` `CALLBACK` info
 * - CALLBACK_BLOCK   - Enable `CALLBACK` command after `CALLBACK_BLOCK` 
 * - CALLBACK_TICK    - `TICK` `token` users get when `CALLBACK` command is used
 * - CALLBACK_AMOUNT  - `TICK` `token` amount that users get when `CALLBACK` command is used
 * - ALLOW_LIST       - `TX_HASH` of a BTNS LIST of addresses allowed to interact with this token
 * - BLOCK_LIST       - `TX_HASH` of a BTNS LIST of addresses NOT allowed to interact with this token
 * - MINT_ADDRESS_MAX - Maximum amount of supply any address can mint via `MINT` transactions
 * - MINT_START_BLOCK - `BLOCK_INDEX` when `MINT` transactions are allowed (begin mint)
 * - MINT_STOP_BLOCK` - `BLOCK_INDEX` when `MINT` transactions are NOT allowed (end mint)
 * 
 * FORMATS :
 * - 0 = Full
 * - 1 = Brief
 * - 2 = Edit MINT PARAMS
 * - 3 = Edit LOCK PARAMS
 * - 4 = Edit CALLBACK PARAMS
 * 
 ********************************************************************/

const util = require('../util.js');

class Issue {

    // Handle constructing a class instance
    constructor(config, decoderDb, indexerDb){
        // Parse in indexer configuration
        this.config    = config;

        // Setup alias to the indexer database connections
        this.decoderDb = decoderDb;
        this.indexerDb = indexerDb;

        // Define list of known FORMATS
        this.formats = {};
        this.formats[0] = 'VERSION|TICK|MAX_SUPPLY|MAX_MINT|DECIMALS|DESCRIPTION|MINT_SUPPLY|TRANSFER|TRANSFER_SUPPLY|LOCK_MAX_SUPPLY|LOCK_MAX_MINT|LOCK_DESCRIPTION|LOCK_RUG|LOCK_SLEEP|LOCK_CALLBACK|CALLBACK_BLOCK|CALLBACK_TICK|CALLBACK_AMOUNT|ALLOW_LIST|BLOCK_LIST|MINT_ADDRESS_MAX|MINT_START_BLOCK|MINT_STOP_BLOCK|LOCK_MINT|LOCK_MINT_SUPPLY';
        this.formats[1] = 'VERSION|TICK|DESCRIPTION';
        this.formats[2] = 'VERSION|TICK|MAX_MINT|MINT_SUPPLY|TRANSFER_SUPPLY|MINT_ADDRESS_MAX|MINT_START_BLOCK|MINT_STOP_BLOCK';
        this.formats[3] = 'VERSION|TICK|LOCK_MAX_SUPPLY|LOCK_MAX_MINT|LOCK_DESCRIPTION|LOCK_RUG|LOCK_SLEEP|LOCK_CALLBACK|LOCK_MINT|LOCK_MINT_SUPPLY';
        this.formats[4] = 'VERSION|TICK|CALLBACK_BLOCK|CALLBACK_TICK|CALLBACK_AMOUNT';

        // Define list of AMOUNT and LOCK fields (used in validations)
        this.fieldList = {};
        this.fieldList['AMOUNT'] = ['MAX_SUPPLY', 'MAX_MINT', 'MINT_SUPPLY', 'CALLBACK_AMOUNT', 'MINT_ADDRESS_MAX', 'MINT_START_BLOCK', 'MINT_STOP_BLOCK'];
        this.fieldList['LOCK']   = ['LOCK_MAX_SUPPLY', 'LOCK_MINT', 'LOCK_MINT_SUPPLY', 'LOCK_MAX_MINT', 'LOCK_DESCRIPTION', 'LOCK_RUG', 'LOCK_SLEEP', 'LOCK_CALLBACK'];
    }

    // Handle parsing the ISSUE transaction
    async parse(params, data, error){
        /*****************************************************************
         * DEBUGGING - Force params
         ****************************************************************/
        // let str    = "0|JDOG|1000||18";
        // params = String(str).split('|');
        // data['SOURCE'] = this.config['ADDRESS']['BURN'];

        // Validate that format is known
        let format = util.getFormatVersion(params[0]);
        if(!error && (format===null || this.formats[format] === undefined ))
            error = 'invalid: VERSION (unknown)';

        // Parse PARAMS using given VERSION format and update BTNS transaction data object
        if(!error)
            data = util.setActionParams(data, params, this.formats[format]);

        // TODO: Decode any base64 tickers
        // if(util.isBase64(data['TICK']))
        //     $data['TICK'] = util.base64Decode(data['TICK']);

        /*****************************************************************
         * TICK Validations
         ****************************************************************/

        // Verify TICK length is within acceptable range
        let len = String(data['TICK']).length,
            min = parseInt(this.config['MIN_TICK_LENGTH']),
            max = parseInt(this.config['MAX_TICK_LENGTH']);
        if(!error && (len < min || len > max))
            error = 'invalid: TICK (length)';

        // Verify no pipe in TICK (pipe is field delimiter)
        if(!error && String(data['TICK']).indexOf('|')!=-1)
            error = 'invalid: TICK (pipe)';

        // Verify no semicolon in TICK (semicolon is action delimiter)
        if(!error && String(data['TICK']).indexOf(';')!=-1)
            error = 'invalid: TICK (semicolon)';

        // Verify TICK is not on RESERVED_TICKS list
        if(!error && this.config['RESERVED_TICKS'].indexOf(data['TICK'])!=-1)
            error = 'invalid: TICK (reserved)';

        // Verify only GAS address can issue on GAS token
        if(!error && String(data['TICK'].toUpperCase())==this.config['GAS'] && data['SOURCE']!=this.config['ADDRESS']['GAS'])        
            error = 'invalid: GAS Address';

        // Get information on token
        let tokenInfo     = await this.indexerDb.getTokenInfo(data['TICK'], null, data['BLOCK_INDEX'], data['TX_INDEX']);
        // let isDistributed = await this.indexerDb.isDistributed(data['TICK'], data['BLOCK_INDEX'], data['TX_INDEX']);

console.log('tokenInfo=',tokenInfo);

        // Clone the raw data for storage in issues table
        let issue = structuredClone(data);

        // Determine final status
        let status = (error) ? error : 'valid';
        data['STATUS'] = issue['STATUS'] = status;

        // Print status message 
        console.log("\t ISSUE : " + data['TICK'] + ' : ' + data['STATUS']);

        // Create record in issues table
        // createIssue($issue);


        // console.log('parse params=',params);
        // console.log('parse isssue=',issue);
        // console.log('parse data=',data);
        // if(error)
        //     console.log('error=',error);
    }

}

module.exports = Issue;