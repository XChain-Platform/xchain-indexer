/*********************************************************************
 * XChain Indexer ACTION - DIVIDEND
 * 
 * PARAMS:
 * - VERSION        - Broadcast Format Version
 * - TICK           - 1 to 250 characters in length
 * - DIVIDEND_TICK  - 1 to 250 characters in length
 * - AMOUNT         - The quantity of DIVIDEND_TICK rewarded per UNIT
 * - MEMO           - An optional memo to include
 * 
 * FORMATS:
 * - 0 = Full
 * 
 ********************************************************************/

class Dividend {

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
        this.formats[0] = 'VERSION|TICK|DIVIDEND_TICK|AMOUNT|MEMO';

        // Define lists of various fields
        this.fieldList = {};

        // Define list of NUMBER fields (used to convert values from string to number)
        this.fieldList['NUMBER'] = ['AMOUNT'];
    }

    // Handle parsing the DIVIDEND transaction
    async parse(params, data, error){
        /*****************************************************************
         * DEBUGGING - Force params
         ****************************************************************/
        // let str = '0|SAT|SAT|1|testing dividends';
        // params = String(str).split('|');

        // Reset the address/tickers/transactions list on each parse
        this.util.resetLists();

        // Validate that format is known
        let format = this.util.getFormatVersion(params[0]);
        if(!error && (format===null || this.formats[format] === undefined ))
            error = 'invalid: VERSION (unknown)';

        // Parse PARAMS using given VERSION format and update transaction data object
        if(!error)
            data = this.util.setActionParams(data, params, this.formats[format]);

        // Clone the raw data for storage in dividends table
        let dividend = structuredClone(data);

        // Convert NUMBER fields from string value to number value so comparisons are mathematical 
        for(let name of this.fieldList['NUMBER']){
            let value = data[name];
            if(!this.util.isNull(value))
                data[name] = this.util.bcnum(value);
        }

        // Get source address balances and preferences, as well as TICK holders list
        let balances    = await this.indexerDb.getAddressBalances(data['SOURCE'], null, data['BLOCK_INDEX'], data['ACTION_INDEX']);
        let preferences = await this.indexerDb.getAddressPreferences(data['SOURCE'], data['BLOCK_INDEX'], data['ACTION_INDEX']);
        let holders     = await this.indexerDb.getHolders(data['TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX']);

        // Get token information on TICK and DIVIDEND_TICK
        let tokenInfo         = await this.indexerDb.getTokenInfo(data['TICK'], null, data['BLOCK_INDEX'], data['ACTION_INDEX']);
        let dividendTokenInfo = await this.indexerDb.getTokenInfo(data['DIVIDEND_TICK'], null, data['BLOCK_INDEX'], data['ACTION_INDEX']);

        // Create the fees object 
        let fees = this.util.createFeesObject(data, preferences);

        // List of recipients which will receive this DIVIDEND
        // Format: recipients['address'] = amount;
        let recipients = {};

        // List of addresses allowed or blocked from holding DIVIDEND_TICK
        let allowList = (dividendTokenInfo['ALLOW_LIST']) ? await this.indexerDb.getList(dividendTokenInfo['ALLOW_LIST']) : false;
        let blockList = [dividendTokenInfo['BLOCK_LIST']] ? await this.indexerDb.getList(dividendTokenInfo['BLOCK_LIST']) : false;

        // Loop through list of holders and build out valid recipients list 
        for(let address in holders){
            let valid = true;
            // Check if recipient is on the allow or block lists and only add valid addresses to the recipients list
            if((allowList.length && !allowList.includes(address)) || (blockList.length && blockList.includes(address)))
                valid = false;
            // Ignore the source address so it is not added to recipients list
            if(address==data['SOURCE'])
                valid = false;
            // Add address to the recipients list and calculate AMOUNT of the DIVIDEND_TICK the address should receive
            if(valid)
                recipients[address] = this.util.bcmul(holders[address], data['AMOUNT'], dividendTokenInfo['DECIMALS']);
        }

        // Determine total DEBIT for this dividend using recipient list
        let totalDebit = 0;
        for(let address in recipients)
            totalDebit = this.util.bcadd(totalDebit, recipients[address], dividendTokenInfo['DECIMALS'])
        dividend['DEBIT'] = totalDebit;

        /*****************************************************************
         * TICK Validations
         ****************************************************************/

        // Validate TICK exists
        if(!error && !tokenInfo)
            error = 'invalid: TICK (unknown)';

        // Validate DIVIDEND_TICK exists
        if(!error && !dividendTokenInfo)
            error = 'invalid: DIVIDEND_TICK (unknown)';

        /*****************************************************************
         * FORMAT Validations
         ****************************************************************/

        // Set TICK and DIVIDEND_TICK divisibility
        let tick_divisible     = (tokenInfo && tokenInfo['DECIMALS]']>=1) ? 1 : 0;
        let dividend_divisible = (dividendTokenInfo && dividendTokenInfo['DECIMALS']>=1) ? 1 : 0;

        // Verify AMOUNT format valid for DIVIDEND_TICK
        if(!error && (this.util.isNull(data['AMOUNT']) || !this.util.isValidAmountFormat(dividend_divisible, data['AMOUNT'])))
            error = "invalid: AMOUNT (format)";

        /*****************************************************************
         * General Validations
         ****************************************************************/


        // Verify no pipe in MEMO (pipe is field delimiter)
        if(!error && !this.util.isNull(data['MEMO']) && String(data['MEMO']).indexOf('|')!=-1)
            error = 'invalid: MEMO (pipe)';

        // Verify no semicolon in MEMO (semicolon is action delimiter)
        if(!error && !this.util.isNull(data['MEMO']) && String(data['MEMO']).indexOf(';')!=-1)
            error = 'invalid: MEMO (semicolon)';

        // Calculate total number of database hits for this DIVIDEND
        let db_hits = 3;                                                                       // 1 dividend, 1 debit, 1 balance 
            db_hits += (recipients) ? this.util.bcmul(Object.keys(recipients).length,2,0) : 0; // 1 credits, 1 balance

        // Determine total transaction FEE based on database hits
        fees['AMOUNT'] = this.util.getTransactionFee(db_hits, fees['TICK']);

        // Verify SOURCE has enough balances to cover DIVIDEND_TICK total DEBIT amount
        if(!error && !this.util.hasBalance(balances, dividendTokenInfo['TICK_ID'], dividend['DEBIT']))
            error = 'invalid: insufficient funds (TICK)';
    
        // Adjust balances to reduce by DIVIDEND_TICK total DEBIT amount
        if(!error)
            balances = this.util.debitBalances(balances, dividendTokenInfo['TICK_ID'], dividend['DEBIT']);

        // Verify SOURCE has enough balances to cover FEE AMOUNT
        if(!error && !this.util.hasBalance(balances, fees['TICK_ID'], fees['AMOUNT']))
            error = 'invalid: insufficient funds (FEE)';

        // Adjust balances to reduce by FEE AMOUNT
        if(!error)
            balances = this.util.debitBalances(balances, fees['TICK_ID'], fees['AMOUNT']);

        // // Determine final status
        let status = (error) ? error : 'valid';
        data['STATUS'] = dividend['STATUS'] = status;

        // Print status message 
        console.log("\t DIVIDEND : " + dividend['TICK'] + ' : ' + dividend['DIVIDEND_TICK'] + ' : ' + dividend['AMOUNT'] + ' : ' + dividend['STATUS']);

        // Create record in dividends table
        await this.indexerDb.createDividend(dividend);

        // If this was a valid transaction, then create the credit and debit records
        if(status=='valid'){

            // Array of credits and debits
            let credits = [],
                debits  = [];

            // Store the SOURCE and TICK in addresses list
            this.util.addAddressTicker(data['SOURCE'], fees['TICK']);

            // Add DIVIDEND_TICK and DEBIT to debits array
            debits.push([dividend['DIVIDEND_TICK'], dividend['DEBIT'], dividend['SOURCE']]);

            // Handle any transaction FEE according the users's ADDRESS preferences
            [credits, debits] = await this.util.processTransactionFees(this.indexerDb, credits, debits, 'DIVIDEND', fees);

            // Loop through recipient addresses
            for(let address in recipients){

                // Store the recipient ADDRESS and TICK in addresses list
                this.util.addAddressTicker(address, dividend['DIVIDEND_TICK']);
    
                // Credit address with DIVIDEND_TICK AMOUNT
                credits.push([dividend['DIVIDEND_TICK'], recipients[address], address]);
            }

            // Process any transaction credit/debit records
            await this.util.processTransactionCreditsDebits(this.indexerDb, credits, debits, data);

            // Get a list of tickers from this dividend
            let tickers = this.util.getTickersList();

            // Get a list of addresses associated with this dividend
            let addresses = Object.keys(this.util.getAddressesList());

            // Update balances for addresses
            await this.indexerDb.updateBalances(addresses);

        }
    }
}

module.exports = Dividend;