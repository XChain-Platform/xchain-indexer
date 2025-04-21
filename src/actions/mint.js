/*********************************************************************
 * XChain Platform Action - MINT
 * 
 * This action mints `TICK` supply.
 * 
 * PARAMS:
 * - VERSION     - Format Version
 * - TICK        - 1 to 250 characters in length
 * - AMOUNT      - Amount of tokens to mint
 * - DESTINATION - Address to transfer tokens to
 * 
 * FORMATS:
 * - 0 = Full
 * 
 ********************************************************************/

class Mint {

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
        let format = this.util.getFormatVersion(params[0]);
        if(!error && (format===null || this.formats[format] === undefined ))
            error = 'invalid: VERSION (unknown)';

        // Parse PARAMS using given VERSION format and update transaction data object
        if(!error)
            data = this.util.setActionParams(data, params, this.formats[format]);

        // Clone the raw data for storage in mints table
        let mint = structuredClone(data);

        // Convert NUMBER fields from string value to number value so comparisons are mathematical 
        for(let name of this.fieldList['NUMBER']){
            let value = data[name];
            if(!this.util.isNull(value))
                data[name] = this.util.bcnum(value);
        }

        // Get information on token
        let tokenInfo = await this.indexerDb.getTokenInfo(data['TICK'], null, data['BLOCK_INDEX'], data['ACTION_INDEX']);

        // Get total token minted from this address
        let minted = await this.indexerDb.getActionCreditDebitAmount('credits', 'MINT', data['TICK'], data['SOURCE'], data['ACTION_INDEX']);

        // Verify TICK is valid before MINT
        if(tokenInfo['BLOCK_INDEX']==data['BLOCK_INDEX'] && !(await this.indexerDb.validTickerBeforeTxIndex(data['TICK'], data['ACTION_INDEX'])))
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
            data['SUPPLY']           = (tokenInfo && !this.util.isNull(tokenInfo['SUPPLY']))           ? this.util.bcnum(tokenInfo['SUPPLY']) : 0;
            data['DECIMALS']         = (tokenInfo && !this.util.isNull(tokenInfo['DECIMALS']))         ? this.util.bcnum(tokenInfo['DECIMALS']) : 0;
            data['MAX_SUPPLY']       = (tokenInfo && !this.util.isNull(tokenInfo['MAX_SUPPLY']))       ? this.util.bcnum(tokenInfo['MAX_SUPPLY']) : 0;
            data['MAX_MINT']         = (tokenInfo && !this.util.isNull(tokenInfo['MAX_MINT']))         ? this.util.bcnum(tokenInfo['MAX_MINT']) : 0;
            data['MINT_ADDRESS_MAX'] = (tokenInfo && !this.util.isNull(tokenInfo['MINT_ADDRESS_MAX'])) ? this.util.bcnum(tokenInfo['MINT_ADDRESS_MAX']) : 0;
            data['MINT_START_BLOCK'] = (tokenInfo && !this.util.isNull(tokenInfo['MINT_START_BLOCK'])) ? this.util.bcnum(tokenInfo['MINT_START_BLOCK']) : 0;
            data['MINT_STOP_BLOCK']  = (tokenInfo && !this.util.isNull(tokenInfo['MINT_STOP_BLOCK']))  ? this.util.bcnum(tokenInfo['MINT_STOP_BLOCK']) : 0;
        }

        // Array of credits and debits
        let credits = [],
            debits  = [];

        /*****************************************************************
         * ACTION Validations
         ****************************************************************/

        // Verify MINT is allowed
        if(!error && !this.util.isNull(tokenInfo['LOCK_MINT']) && tokenInfo['LOCK_MINT']==1)
            error = "invalid: LOCK_MINT";

        /*****************************************************************
         * FORMAT Validations
         ****************************************************************/

        // Verify AMOUNT format
        if(!error && !this.util.isNull(data['AMOUNT']) && !this.util.isValidAmountFormat(tick_divisible, data['AMOUNT']))
            error = "invalid: AMOUNT (format)";

        // Verify DESTINATION address format
        if(!error && !this.util.isNull(data['DESTINATION']) && !this.util.isCryptoAddress(data['DESTINATION']))
            error = "invalid: DESTINATION (format)";

        /*****************************************************************
         * General Validations
         ****************************************************************/

        // Verify SOURCE is allowed to perform action
        if(!error && !await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']))
            error = 'invalid: SOURCE (sleeping)';

        // Verify TICK is allowed to perform action
        if(!error && !await this.indexerDb.isActionAllowed(null, data['TICK'], data['BLOCK_INDEX']))
            error = 'invalid: TICK (sleeping)';

        // Verify no pipe in MEMO (pipe is field delimiter)
        if(!error && !this.util.isNull(data['MEMO']) && String(data['MEMO']).indexOf('|')!=-1)
            error = 'invalid: MEMO (pipe)';

        // Verify no semicolon in MEMO (semicolon is action delimiter)
        if(!error && !this.util.isNull(data['MEMO']) && String(data['MEMO']).indexOf(';')!=-1)
            error = 'invalid: MEMO (semicolon)';

        // Verify MEMO is shorter than MAX_MEMO_LENGTH
        if(!error && String(data['MEMO']).length > this.config['MAX_MEMO_LENGTH'])
            error = 'invalid: MEMO (length)';

        // Verify AMOUNT is less than MAX_MINT
        if(!error && !this.util.isNull(data['AMOUNT']) && data['AMOUNT'] > data['MAX_MINT'])
            error = 'invalid: AMOUNT > MAX_MINT';

        // Verify minting AMOUNT will not exceed MAX_SUPPLY
        if(!error && (this.util.bcadd(data['SUPPLY'],data['AMOUNT'],data['DECIMALS']) > this.util.bcadd(data['MAX_SUPPLY'],0,data['DECIMALS'])))
            error = 'invalid: mint exceeds MAX_SUPPLY';

        // Verify TICK action is allowed from SOURCE (allow/block lists)
        if(!error && !await this.indexerDb.isActionAllowed(data['SOURCE'], data['TICK']))
            error = 'invalid: SOURCE (not authorized)';

        // Verify TICK action is allowed to DESTINATION (ALLOW_LIST & BLOCK_LIST)
        if(!error && !this.util.isNull(data['DESTINATION']) && !await this.indexerDb.isActionAllowed(data['DESTINATION'], data['TICK']))
            error = 'invalid: DESTINATION (not authorized)';

        // Verify minting AMOUNT will not exceed MINT_ADDRESS_MAX
        if(!error && !this.util.isNull(data['MINT_ADDRESS_MAX']) && data['MINT_ADDRESS_MAX'] > 0 && this.util.bcadd(minted, data['AMOUNT'], data['DECIMALS']) > data['MINT_ADDRESS_MAX'])
            error = 'invalid: mint exceeds MINT_ADDRESS_MAX';

        // Verify minting begins at MINT_START_BLOCK
        if(!error && !this.util.isNull(data['MINT_START_BLOCK']) && data['MINT_START_BLOCK'] > 0 && data['BLOCK_INDEX'] < data['MINT_START_BLOCK'])
            error = 'invalid: MINT_START_BLOCK';

        // Verify minting ends at MINT_STOP_BLOCK
        if(!error && !this.util.isNull(data['MINT_STOP_BLOCK']) && data['MINT_STOP_BLOCK'] > 0 && data['BLOCK_INDEX'] > data['MINT_STOP_BLOCK'])
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
                credits.push([data['TICK'], data['AMOUNT'], data['SOURCE']]);

                // Transfer AMOUNT to DESTINATION address
                if(data['DESTINATION']){
                    debits.push([data['TICK'],  data['AMOUNT'], data['SOURCE']]);
                    credits.push([data['TICK'], data['AMOUNT'], data['DESTINATION']]);
                }
            }

            // Process any transaction credit/debit records
            await this.util.processTransactionCreditsDebits(this.indexerDb, credits, debits, data);

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