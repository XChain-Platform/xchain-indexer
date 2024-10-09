/*********************************************************************
 * XChain Indexer ACTION - MINT
 * 
 * PARAMS:
 * - VERSION     - Broadcast Format Version
 * - TICK        - 1 to 250 characters in length
 * - AMOUNT      - Amount of tokens to mint
 * - DESTINATION - Address to transfer tokens to
 * 
 * FORMATS:
 * - 0 = Full
 * 
 ********************************************************************/

const util = require('../util.js');

class Mint {

    // Handle constructing a class instance
    constructor(config, decoderDb, indexerDb){
        // Parse in indexer configuration
        this.config    = config;

        // Setup alias to the indexer database connections
        this.decoderDb = decoderDb;
        this.indexerDb = indexerDb;

        // Define list of known FORMATS
        this.formats = {};
        this.formats[0] = 'VERSION|TICK|AMOUNT|DESTINATION|MEMO';

        // Define lists of various fields
        this.fieldList = {};

        // Define list of NUMBER fields (used to convert values from string to number)
        this.fieldList['NUMBER'] = ['AMOUNT'];

    }

    // Handle parsing the MINT transaction
    async parse(params, data, error){
        /*****************************************************************
         * DEBUGGING - Force params
         ****************************************************************/
        // let str    = "0|JDOG|1|";
        // params = String(str).split('|');

        // Validate that format is known
        let format = util.getFormatVersion(params[0]);
        if(!error && (format===null || this.formats[format] === undefined ))
            error = 'invalid: VERSION (unknown)';

        // Parse PARAMS using given VERSION format and update transaction data object
        if(!error)
            data = util.setActionParams(data, params, this.formats[format]);

        // Clone the raw data for storage in mints table
        let mint = structuredClone(data);

        // Convert NUMBER fields from string value to number value so comparisons are mathematical 
        this.fieldList['NUMBER'].forEach(function(name){
            let value = data[name];
            if(!util.isNull(value))
                data[name] = util.bcnum(value);
        });

        // Get information on token
        let tokenInfo = await this.indexerDb.getTokenInfo(data['TICK'], null, data['BLOCK_INDEX'], data['TX_INDEX']);

        // Verify TICK is valid before MINT
        if(tokenInfo['BLOCK_INDEX']==data['BLOCK_INDEX'] && !(await this.indexerDb.validTickerBeforeTxIndex(data['TICK'], data['TX_INDEX'])))
            tokenInfo = null;

        // Set divisible first based on if token exist, if not, use DECIMALS in request
        let tick_divisible = (data['DECIMALS]']==0) ? 0 : 1;

        // Validate TICK exists
        if(!error && !tokenInfo)
            error = 'invalid: TICK (unknown)';

        // Validate DESTINATION and SOURCE are different
        if(data['DESTINATION'] == data['SOURCE'])
            delete data['DESTINATION'];

        // Update transaction object with basic token details and ensure the values are numbers and not strings
        if(tokenInfo){
            data['SUPPLY']           = (tokenInfo && !util.isNull(tokenInfo['SUPPLY']))           ? util.bcnum(tokenInfo['SUPPLY']) : 0;
            data['DECIMALS']         = (tokenInfo && !util.isNull(tokenInfo['DECIMALS']))         ? util.bcnum(tokenInfo['DECIMALS']) : 0;
            data['MAX_SUPPLY']       = (tokenInfo && !util.isNull(tokenInfo['MAX_SUPPLY']))       ? util.bcnum(tokenInfo['MAX_SUPPLY']) : 0;
            data['MAX_MINT']         = (tokenInfo && !util.isNull(tokenInfo['MAX_MINT']))         ? util.bcnum(tokenInfo['MAX_MINT']) : 0;
            data['MINT_ADDRESS_MAX'] = (tokenInfo && !util.isNull(tokenInfo['MINT_ADDRESS_MAX'])) ? util.bcnum(tokenInfo['MINT_ADDRESS_MAX']) : 0;
            data['MINT_START_BLOCK'] = (tokenInfo && !util.isNull(tokenInfo['MINT_START_BLOCK'])) ? util.bcnum(tokenInfo['MINT_START_BLOCK']) : 0;
            data['MINT_STOP_BLOCK']  = (tokenInfo && !util.isNull(tokenInfo['MINT_STOP_BLOCK']))  ? util.bcnum(tokenInfo['MINT_STOP_BLOCK']) : 0;
        }

        /*****************************************************************
         * ACTION Validations
         ****************************************************************/

        // Verify MINT is allowed
        if(!error && !util.isNull(tokenInfo['LOCK_MINT']) && tokenInfo['LOCK_MINT']==1)
            error = "invalid: LOCK_MINT";

        /*****************************************************************
         * FORMAT Validations
         ****************************************************************/

        // Verify AMOUNT format
        if(!error && !util.isNull(data['AMOUNT']) && !util.isValidAmountFormat(tick_divisible, data['AMOUNT']))
            error = "invalid: AMOUNT (format)";

        // Verify DESTINATION address format
        if(!error && !util.isNull(data['DESTINATION']) && !util.isCryptoAddress(data['DESTINATION']))
            error = "invalid: DESTINATION (format)";

        /*****************************************************************
         * General Validations
         ****************************************************************/

        // Verify no pipe in MEMO (pipe is field delimiter)
        if(!error && !util.isNull(data['MEMO']) && String(data['MEMO']).indexOf('|')!=-1)
            error = 'invalid: MEMO (pipe)';

        // Verify no semicolon in MEMO (semicolon is action delimiter)
        if(!error && !util.isNull(data['MEMO']) && String(data['MEMO']).indexOf(';')!=-1)
            error = 'invalid: MEMO (semicolon)';

        // Verify AMOUNT is less than MAX_MINT
        if(!error && !util.isNull(data['AMOUNT']) && data['AMOUNT'] > data['MAX_MINT'])
            error = 'invalid: AMOUNT > MAX_MINT';

        // Verify minting AMOUNT will not exceed MAX_SUPPLY
        if(!error && (util.bcadd(data['SUPPLY'],data['AMOUNT'],data['DECIMALS']) > util.bcadd(data['MAX_SUPPLY'],0,data['DECIMALS'])))
            error = 'invalid: mint exceeds MAX_SUPPLY';

        // Verify action is allowed from SOURCE (ALLOW_LIST & BLOCK_LIST)
        if(!error && !await this.indexerDb.isActionAllowed(data['TICK'], data['SOURCE']))
            error = 'invalid: SOURCE (not authorized)';

        // Verify action is allowed to DESTINATION (ALLOW_LIST & BLOCK_LIST)
        if(!error && !util.isNull(data['DESTINATION']) && !await this.indexerDb.isActionAllowed(data['TICK'], data['DESTINATION']))
            error = 'invalid: DESTINATION (not authorized)';

        // Verify minting AMOUNT will not exceed MINT_ADDRESS_MAX
        if(!error && !util.isNull(data['MINT_ADDRESS_MAX']) && data['MINT_ADDRESS_MAX'] > 0 && (util.bcadd(await this.indexerDb.getActionCreditDebitAmount('credits', 'MINT', data['TICK'], data['SOURCE'], data['TX_INDEX']),data['AMOUNT'],data['DECIMALS']) > data['MINT_ADDRESS_MAX']))
            error = 'invalid: mint exceeds MINT_ADDRESS_MAX';

        // Verify minting begins at MINT_START_BLOCK
        if(!error && !util.isNull(data['MINT_START_BLOCK']) && data['MINT_START_BLOCK'] > 0 && data['BLOCK_INDEX'] < data['MINT_START_BLOCK'])
            error = 'invalid: MINT_START_BLOCK';

        // Verify minting ends at MINT_STOP_BLOCK
        if(!error && !util.isNull(data['MINT_STOP_BLOCK']) && data['MINT_STOP_BLOCK'] > 0 && data['BLOCK_INDEX'] > data['MINT_STOP_BLOCK'])
            error = 'invalid: MINT_STOP_BLOCK';

        // Determine final status
        let status = (error) ? error : 'valid';
        data['STATUS'] = mint['STATUS'] = status;

        // Print status message 
        console.log("\t MINT : " + data['TICK'] + ' : '  +  data['AMOUNT'] + ' : ' + data['STATUS']);

        // Create record in mints table
        await this.indexerDb.createMint(mint);

        // If this was a valid transaction, then mint any actual supply
        if(status=='valid'){

            // Credit MINT_SUPPLY to source address
            if(data['AMOUNT']){
                await this.indexerDb.createCredit('MINT', data['BLOCK_INDEX'], data['TX_HASH'], data['TICK'], data['AMOUNT'], data['SOURCE']);

                // Transfer AMOUNT to DESTINATION address
                if(data['DESTINATION']){
                    await this.indexerDb.createDebit('MINT',  data['BLOCK_INDEX'], data['TX_HASH'], data['TICK'], data['AMOUNT'], data['SOURCE']);
                    await this.indexerDb.createCredit('MINT', data['BLOCK_INDEX'], data['TX_HASH'], data['TICK'], data['AMOUNT'], data['DESTINATION']);
                }
            }

            // If this is a reparse, bail out before updating balances and token information
            // if(reparse)
            //     return;

            // Update balances for addresses
            await this.indexerDb.updateBalances([data['SOURCE'], data['DESTINATION']]);

            // Update supply for token
            await this.indexerDb.updateTokenInfo(data['TICK']);
        }

    }
}

module.exports = Mint;