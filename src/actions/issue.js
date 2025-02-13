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
 * - ALLOW_LIST       - `TX_HASH` of a LIST of addresses allowed to interact with this token
 * - BLOCK_LIST       - `TX_HASH` of a LIST of addresses NOT allowed to interact with this token
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

class Issue {

    // Handle constructing a class instance
    constructor(action){
        // Parse in indexer configuration
        this.config    = action.config;

        // Setup alias to the indexer database connections
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;

        // Setup alias to utility class
        this.util      = action.util;

        // Define list of known FORMATS
        this.formats = {};
        this.formats[0] = 'VERSION|TICK|MAX_SUPPLY|MAX_MINT|DECIMALS|DESCRIPTION|MINT_SUPPLY|TRANSFER|TRANSFER_SUPPLY|LOCK_MAX_SUPPLY|LOCK_MAX_MINT|LOCK_DESCRIPTION|LOCK_RUG|LOCK_SLEEP|LOCK_CALLBACK|CALLBACK_BLOCK|CALLBACK_TICK|CALLBACK_AMOUNT|ALLOW_LIST|BLOCK_LIST|MINT_ADDRESS_MAX|MINT_START_BLOCK|MINT_STOP_BLOCK|LOCK_MINT|LOCK_MINT_SUPPLY';
        this.formats[1] = 'VERSION|TICK|DESCRIPTION';
        this.formats[2] = 'VERSION|TICK|MAX_MINT|MINT_SUPPLY|TRANSFER_SUPPLY|MINT_ADDRESS_MAX|MINT_START_BLOCK|MINT_STOP_BLOCK';
        this.formats[3] = 'VERSION|TICK|LOCK_MAX_SUPPLY|LOCK_MAX_MINT|LOCK_DESCRIPTION|LOCK_RUG|LOCK_SLEEP|LOCK_CALLBACK|LOCK_MINT|LOCK_MINT_SUPPLY';
        this.formats[4] = 'VERSION|TICK|CALLBACK_BLOCK|CALLBACK_TICK|CALLBACK_AMOUNT';

        // Define lists of various fields
        this.fieldList = {};

        // Define list of NUMBER fields (used to convert values from string to number)
        this.fieldList['NUMBER'] = ['MAX_SUPPLY', 'MAX_MINT', 'DECIMALS', 'MINT_SUPPLY', 'TRANSFER_SUPPLY', 'CALLBACK_BLOCK', 'CALLBACK_AMOUNT', 'MINT_ADDRESS_MAX', 'MINT_START_BLOCK', 'MINT_STOP_BLOCK'];

        // Define list of AMOUNT, LOCK fields (used in validations)
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
        let format = this.util.getFormatVersion(params[0]);
        if(!error && (format===null || this.formats[format] === undefined ))
            error = 'invalid: VERSION (unknown)';

        // Parse PARAMS using given VERSION format and update transaction data object
        if(!error)
            data = this.util.setActionParams(data, params, this.formats[format]);

        // TODO: Decode any base64 tickers
        // if(this.util.isBase64(data['TICK']))
        //     $data['TICK'] = this.util.base64Decode(data['TICK']);

        // Clone the raw data for storage in issues table
        let issue = structuredClone(data);

        // Convert NUMBER fields from string value to number value so comparisons are mathematical 
        for(let name of this.fieldList['NUMBER']){
            let value = data[name];
            if(!this.util.isNull(value))
                data[name] = this.util.bcnum(value);
        }

        // Array of credits and debits
        let credits = [],
            debits  = [];

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
        let isDistributed = await this.indexerDb.isDistributed(data['TICK'], data['BLOCK_INDEX'], data['TX_INDEX']);

        // Populate empty PARAMS with current setting
        if(tokenInfo){
            for(let key in tokenInfo){
                if(!data[key])
                    data[key] = tokenInfo[key];
            }
        }

        // Get information on CALLBACK_TICK
        let cbInfo = false;
        if(data['CALLBACK_TICK'])
            cbInfo = await this.indexerDb.getTokenInfo(data['CALLBACK_TICK'], null, data['BLOCK_INDEX'], data['TX_INDEX']);

        /*****************************************************************
         * FORMAT Validations
         ****************************************************************/

        // Set divisible first based on if token exist, if not, use DECIMALS in request
        let tick_divisible = (data['DECIMALS]']==0) ? 0 : 1;
        if(tokenInfo)
            tick_divisible = (tokenInfo['DECIMALS']==0) ? 0 : 1;

        // Set CALLBACK_TICK divisibillity flag
        let callback_divisible = (cbInfo && cbInfo['DECIMALS']>0) ? 1 : 0;

        // Verify AMOUNT field formats
        for(let name of this.fieldList['AMOUNT']){
            let value = issue[name],
                div   = (name=='CALLBACK_AMOUNT') ? callback_divisible : tick_divisible;
            if(!error && !this.util.isNull(value) && !this.util.isValidAmountFormat(div, value))
                error = "invalid: " + name + " (format)";
        }

        // Verify LOCK field formats
        for(let name of this.fieldList['LOCK']){
            let value = issue[name];
            if(!error && !this.util.isNull(value) && !this.util.isValidLockValue(value))
                error = "invalid: " + name + " (format)";
        };

        /*****************************************************************
         * General Validations
         ****************************************************************/

        // Verify ISSUE is coming from TICK owner
        if(!error && tokenInfo && tokenInfo['OWNER']!=data['SOURCE'])
            error = 'invalid: issued by another address';

        // Verify LOCK fields cannot be changed once enabled/locked
        for(let name of this.fieldList['LOCK']){
            let value = issue[name];
            if(!error && tokenInfo && !this.util.isNull(value) && !this.util.isValidLock(tokenInfo, issue, name))
                error = "invalid: " + name + " (locked)";
        }

        // Verify MAX_SUPPLY min/max
        if(!error && !this.util.isNull(data['MAX_SUPPLY']) && data['MAX_SUPPLY'] > 0 && (data['MAX_SUPPLY'] < this.config.MIN_TOKEN_SUPPLY || data['MAX_SUPPLY'] > this.config.MAX_TOKEN_SUPPLY))
            $error = 'invalid: MAX_SUPPLY (min/max)';

        // Verify MAX_SUPPLY is not set below current SUPPLY
        if(!error && !this.util.isNull(data['MAX_SUPPLY']) && data['MAX_SUPPLY'] > 0 && data['MAX_SUPPLY'] < await this.indexerDb.getTokenSupply(data['TICK'], null, data['BLOCK_INDEX'], data['TX_INDEX']))
            error = 'invalid: MAX_SUPPLY < SUPPLY';

        // Verify SUPPLY is at least MIN_TOKEN_SUPPLY before allowing LOCK_MAX_SUPPLY
        if(!error && data['LOCK_MAX_SUPPLY'] && ((tokenInfo && tokenInfo['SUPPLY'] < this.config.MIN_TOKEN_SUPPLY) || (!tokenInfo && data['MINT_SUPPLY'] < this.config.MIN_TOKEN_SUPPLY)))
            error = 'invalid: LOCK_MAX_SUPPLY (no supply)';

        // Verify DECIMAL min/max
        if(!error && !this.util.isNull(data['DECIMALS']) && (data['DECIMALS'] < this.config.MIN_TOKEN_DECIMALS || data['DECIMALS'] > this.config.MAX_TOKEN_DECIMALS))
            error = 'invalid: DECIMALS (min/max)';

        // Verify DECIMALS cannot be changed after supply has been issued
        if(!error && !this.util.isNull(data['DECIMALS']) && tokenInfo['SUPPLY'] > 0 && data['DECIMALS']!=tokenInfo['DECIMALS'])
            error = 'invalid: DECIMALS (locked)';

        // Verify TRANSFER addresses
        if(!error && !this.util.isNull(data['TRANSFER']) && !this.util.isCryptoAddress(data['TRANSFER']))
            error = 'invalid: TRANSFER (bad address)';

        // Verify TRANSFER_SUPPLY and SOURCE are different
        if(data['TRANSFER_SUPPLY'] == data['SOURCE'])
            delete data['TRANSFER_SUPPLY'];

        // Verify TRANSFER_SUPPLY addresses
        if(!error && !this.util.isNull(data['TRANSFER_SUPPLY']) && !this.util.isCryptoAddress(data['TRANSFER_SUPPLY']))
            error = 'invalid: TRANSFER_SUPPLY (bad address)';

        // Verify MINT_SUPPLY is allowed and LOCK_MINT_SUPPLY is not set
        if(!error && !this.util.isNull(data['MINT_SUPPLY']) && tokenInfo && tokenInfo['LOCK_MINT_SUPPLY']==1)
            error = 'invalid: MINT_SUPPLY (locked)';

        // Verify MINT_SUPPLY is less than MAX_SUPPLY
        if(!error && !this.util.isNull(data['MINT_SUPPLY']) && data['MINT_SUPPLY'] > data['MAX_SUPPLY'])
            error = 'invalid: MINT_SUPPLY > MAX_SUPPLY';

        // Verify MINT_ADDRESS_MAX is less than MAX_SUPPLY
        if(!error && !this.util.isNull(data['MINT_ADDRESS_MAX']) && data['MINT_ADDRESS_MAX'] > 0 && data['MINT_ADDRESS_MAX'] > data['MAX_SUPPLY'])
            error = 'invalid: MINT_ADDRESS_MAX > MAX_SUPPLY';

        // Verify MINT_ADDRESS_MAX is greater than than MAX_MINT
        if(!error && !this.util.isNull(data['MINT_ADDRESS_MAX']) && data['MINT_ADDRESS_MAX'] > 0 && data['MINT_ADDRESS_MAX'] < data['MAX_MINT'])
            error = 'invalid: MINT_ADDRESS_MAX < MAX_MINT';

        // Verify MAX_SUPPLY can not be changed if LOCK_MAX_SUPPLY is enabled
        if(!error && tokenInfo && tokenInfo['LOCK_MAX_SUPPLY'] && !this.util.isNull(data['MAX_SUPPLY']) && data['MAX_SUPPLY'] != tokenInfo['MAX_SUPPLY'])
            error = 'invalid: MAX_SUPPLY (locked)';

        // Verify MAX_MINT can not be changed if LOCK_MAX_MINT is enabled
        if(!error && tokenInfo && tokenInfo['LOCK_MAX_MINT'] && !this.util.isNull(data['MAX_MINT']) && data['MAX_MINT'] != tokenInfo['MAX_MINT'])
            error = 'invalid: MAX_MINT (locked)';

        // Verify DESCRIPTION is less than or equal to MAX_TOKEN_DESCRIPTION
        if(!error && data['DESCRIPTION'] && String(data['DESCRIPTION']).length >= this.config.MAX_TOKEN_DESCRIPTION)
            error = 'invalid: DESCRIPTION (length)';

        // Verify DESCRIPTION can not be changed if LOCK_DESCRIPTION is enabled
        if(!error && tokenInfo && tokenInfo['LOCK_DESCRIPTION'] && !this.util.isNull(data['DESCRIPTION']) && data['DESCRIPTION'] != tokenInfo['DESCRIPTION'])
            error = 'invalid: DESCRIPTION (locked)';

        // Verify CALLBACK_BLOCK can not be changed if LOCK_CALLBACK is enabled
        if(!error && tokenInfo && tokenInfo['LOCK_CALLBACK'] && !this.util.isNull(data['CALLBACK_BLOCK']) && data['CALLBACK_BLOCK'] != tokenInfo['CALLBACK_BLOCK'])
            error = 'invalid: CALLBACK_BLOCK (locked)';

        // Verify CALLBACK_TICK can not be changed if LOCK_CALLBACK is enabled
        if(!error && tokenInfo && tokenInfo['LOCK_CALLBACK'] && !this.util.isNull(data['CALLBACK_TICK']) && data['CALLBACK_TICK'] != tokenInfo['CALLBACK_TICK'])
            error = 'invalid: CALLBACK_TICK (locked)';

        // Verify CALLBACK_TICK can not be changed if LOCK_CALLBACK is enabled
        if(!error && tokenInfo && tokenInfo['LOCK_CALLBACK'] && !this.util.isNull(data['CALLBACK_AMOUNT']) && data['CALLBACK_AMOUNT'] != tokenInfo['CALLBACK_AMOUNT'])
            error = 'invalid: CALLBACK_AMOUNT (locked)';

        // Verify CALLBACK_BLOCK is greater than current block index
        if(!error && tokenInfo && !this.util.isNull(issue['CALLBACK_BLOCK']) && data['CALLBACK_BLOCK'] < data['BLOCK_INDEX'])
            error = 'invalid: CALLBACK_BLOCK (block index)';

        // Verify CALLBACK_BLOCK can not be changed if supply is distributed
        if(!error && !this.util.isNull(issue['CALLBACK_BLOCK']) && data['CALLBACK_BLOCK'] != tokenInfo['CALLBACK_BLOCK'] && isDistributed)
            error = 'invalid: CALLBACK_BLOCK (supply distributed)';

        // Verify CALLBACK_TICK can not be changed if supply is distributed
        if(!error && !this.util.isNull(issue['CALLBACK_TICK']) && data['CALLBACK_TICK'] != tokenInfo['CALLBACK_TICK'] && isDistributed)
            error = 'invalid: CALLBACK_TICK (supply distributed)';

        // // Verify CALLBACK_AMOUNT can not be changed if supply is distributed
        if(!error && !this.util.isNull(issue['CALLBACK_AMOUNT']) && data['CALLBACK_AMOUNT'] != tokenInfo['CALLBACK_AMOUNT'] && isDistributed)
            error = 'invalid: CALLBACK_AMOUNT (supply distributed)';

        // Verify ALLOW_LIST is a valid list of addresses
        if(!error && !this.util.isNull(data['ALLOW_LIST']) && !this.indexerDb.isValidList(data['ALLOW_LIST'],3))
            error = 'invalid: ALLOW_LIST (bad list)';

        // // Verify BLOCK_LIST is a valid list of addresses
        if(!error && !this.util.isNull(data['BLOCK_LIST']) && !this.indexerDb.isValidList(data['BLOCK_LIST'],3))
            error = 'invalid: BLOCK_LIST (bad list)';

        // Verify MINT_START_BLOCK is greater than or equal to current block
        if(!error && !this.util.isNull(issue['MINT_START_BLOCK']) && issue['MINT_START_BLOCK'] > 0 && issue['MINT_START_BLOCK'] < issue['BLOCK_INDEX'])
            error = 'invalid: MINT_START_BLOCK < BLOCK_INDEX';

        // Verify MINT_STOP_BLOCK is greater than or equal to current block
        if(!error && !this.util.isNull(issue['MINT_STOP_BLOCK']) && issue['MINT_STOP_BLOCK'] > 0 && issue['MINT_STOP_BLOCK'] < issue['BLOCK_INDEX'])
            error = 'invalid: MINT_STOP_BLOCK < BLOCK_INDEX';

        // Verify MINT_STOP_BLOCK is greater than or equal to MINT_START_BLOCK
        if(!error && !this.util.isNull(issue['MINT_STOP_BLOCK']) && issue['MINT_START_BLOCK'] > 0 && issue['MINT_STOP_BLOCK'] > 0 && issue['MINT_STOP_BLOCK'] < issue['MINT_START_BLOCK'])
            error = 'invalid: MINT_STOP_BLOCK < MINT_START_BLOCK';

        // Determine final status
        let status = (error) ? error : 'valid';
        data['STATUS'] = issue['STATUS'] = status;

        // Print status message 
        console.log("\t ISSUE : " + data['TICK'] + ' : ' + data['STATUS']);

        // Create record in issues table
        await this.indexerDb.createIssue(issue);

        // If this was a valid transaction, then create the token record, and perform any additional actions
        if(status=='valid'){

            // Support token ownership transfers
            data['OWNER']  = (!this.util.isNull(data['TRANSFER'])) ? data['TRANSFER'] : data['SOURCE'];

            // Create/Update record in tokens table
            await this.indexerDb.createToken(data);

            // Credit MINT_SUPPLY to source address
            if(data['MINT_SUPPLY'])
                credits.push([data['TICK'], data['MINT_SUPPLY'], data['SOURCE']]);

            // Transfer MINT_SUPPLY to TRANSFER_SUPPLY address
            if(data['MINT_SUPPLY'] && data['TRANSFER_SUPPLY']){
                debits.push([data['TICK'],  data['MINT_SUPPLY'], data['SOURCE']]);
                credits.push([data['TICK'], data['MINT_SUPPLY'], data['TRANSFER_SUPPLY']]);
            }

            // Process any transaction credit/debit records
            await this.util.processTransactionCreditsDebits(this.indexerDb, credits, debits, 'ISSUE', data);

            // TODO: If this is a reparse, bail out before updating balances and token information
            // if(reparse)
            //     return;

            // Update balances for addresses
            await this.indexerDb.updateBalances([data['SOURCE'], data['TRANSFER_SUPPLY']]);

            // Update supply for token
            await this.indexerDb.updateTokenInfo(data['TICK']);

        }    
    }
}

module.exports = Issue;