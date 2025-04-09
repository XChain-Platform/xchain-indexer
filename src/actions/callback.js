/*********************************************************************
 * XChain Indexer ACTION - CALLBACK
 * 
 * PARAMS:
 * - VERSION - Format Version
 * - TICK    - 1 to 250 characters in length
 * - MEMO    - An optional memo to include
 * 
 * FORMATS:
 * - 0 = Full
 * 
 ********************************************************************/

class Callback {

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
        this.formats[0] = 'VERSION|TICK|MEMO';

        // Define lists of various fields
        this.fieldList = {};

        // Define list of NUMBER fields (used to convert values from string to number)
        this.fieldList['NUMBER'] = ['CALLBACK_BLOCK','CALLBACK_AMOUNT'];
    }

    // Handle parsing the CALLBACK transaction
    async parse(params, data, error){
        /*****************************************************************
         * DEBUGGING - Force params
         ****************************************************************/
        // let str    = "0|SAT|Testing";
        // params = String(str).split('|');

        // Validate that format is known
        let format = this.util.getFormatVersion(params[0]);
        if(!error && (format===null || this.formats[format] === undefined ))
            error = 'invalid: VERSION (unknown)';

        // Parse PARAMS using given VERSION format and update transaction data object
        if(!error)
            data = this.util.setActionParams(data, params, this.formats[format]);

        // Clone the raw data for storage in callbacks table
        let callback = structuredClone(data);

        // Get information on token and callback token
        let tokenInfo         = await this.indexerDb.getTokenInfo(data['TICK'], null, data['BLOCK_INDEX'], data['ACTION_INDEX']);
        let callbackTokenInfo = await this.indexerDb.getTokenInfo(tokenInfo['CALLBACK_TICK'], null, data['BLOCK_INDEX'], data['ACTION_INDEX']);

        // Get source address balances and preferences, as well as TICK holders list
        let balances    = await this.indexerDb.getAddressBalances(data['SOURCE'], null, data['BLOCK_INDEX'], data['ACTION_INDEX']);
        let preferences = await this.indexerDb.getAddressPreferences(data['SOURCE'], data['BLOCK_INDEX'], data['ACTION_INDEX']);
        let holders     = await this.indexerDb.getHolders(data['TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX']);

        // List of addresses allowed or blocked from holding CALLBACK_TICK
        let allowList = (callbackTokenInfo['ALLOW_LIST']) ? await this.indexerDb.getList(callbackTokenInfo['ALLOW_LIST']) : false;
        let blockList = [callbackTokenInfo['BLOCK_LIST']] ? await this.indexerDb.getList(callbackTokenInfo['BLOCK_LIST']) : false;

        // Create the fees object 
        let fees = this.util.createFeesObject(data, preferences);

        // List of recipients which will receive CALLBACK_TICK
        // Format: recipients['address'] = amount;
        let recipients = {};

        // Convert NUMBER fields from string value to number value so comparisons are mathematical
        if(tokenInfo){
            for(let name of this.fieldList['NUMBER']){
                let value = tokenInfo[name];
                if(!this.util.isNull(value))
                    tokenInfo[name] = this.util.bcnum(value);
            }
            // Populate callback object with callback data
            callback['CALLBACK_TICK']   = tokenInfo['CALLBACK_TICK'];
            callback['CALLBACK_AMOUNT'] = tokenInfo['CALLBACK_AMOUNT'];
        }

        // Placeholders for total amounts for TICK and CALLBACK_TICK
        let totalTickAmount         = 0;
        let totalCallbackTickAmount = 0;

        // Loop through list of holders and build out valid recipients list and calculate total TICK and CALLBACK_TICK amounts
        for(let address in holders){
            let valid  = true;

            // Ignore the source address so it is not included in calculations
            if(address==data['SOURCE'])
               continue;

            // Check if recipient is on the allow or block lists and only add valid addresses to the recipients list
            if((allowList.length && !allowList.includes(address)) || (blockList.length && blockList.includes(address)))
                valid = false;

            if(valid){
                // Calculate AMOUNT of CALLBACK_TICK this address should receive (BALANCE * CALLBACK_AMOUNT)
                let amount = this.util.bcmul(holders[address], tokenInfo['CALLBACK_AMOUNT'], callbackTokenInfo['DECIMALS']);

                // Add address and AMOUNT to the recipients list
                recipients[address]  = amount;

                // Add CALLBACK_TICK amount to totalCallbackTickAmount
                totalCallbackTickAmount = this.util.bcadd(totalCallbackTickAmount, amount, callbackTokenInfo['DECIMALS'])
            }

            // Add TICK amount to totalTickAmount
            totalTickAmount = this.util.bcadd(totalTickAmount, holders[address], tokenInfo['DECIMALS'])
        }

        // Calculate total number of database hits for this CALLBACK
        let db_hits = 4;                                                                       // 1 debits, 1 credits, 1 balances, 1 callback
            db_hits += (recipients) ? this.util.bcmul(Object.keys(recipients).length,3,0) : 0; // 1 debits, 1 credits, 1 balances

        // Determine total transaction FEE based on database hits
        fees['AMOUNT'] = this.util.getTransactionFee(db_hits, fees['TICK']);

        /*****************************************************************
         * ACTION Validations
         ****************************************************************/

        // Verify CALLBACK is allowed
        if(!error && !this.util.isNull(tokenInfo['LOCK_CALLBACK']) && tokenInfo['LOCK_CALLBACK']==1)
            error = "invalid: LOCK_CALLBACK";

        // Verify only token OWNER can perform CALLBACK action
        if(!error && data['SOURCE']!=tokenInfo['OWNER'])
            error = "invalid: SOURCE (not authorized)";

        /*****************************************************************
         * TICK Validations
         ****************************************************************/

        // Validate TICK exists
        if(!error && !tokenInfo)
            error = 'invalid: TICK (unknown)';

        // Validate CALLBACK_TICK exists
        if(!error && !callbackTokenInfo)
            error = 'invalid: CALLBACK_TICK (unknown)';

        /*****************************************************************
         * FORMAT Validations
         ****************************************************************/

        // Verify CALLBACK_BLOCK format
        if(!error && tokenInfo && !this.util.isNull(tokenInfo['CALLBACK_BLOCK']) && tokenInfo['CALLBACK_BLOCK'] != parseInt(tokenInfo['CALLBACK_BLOCK']))
            error = 'invalid: CALLBACK_BLOCK (format)';

        // Verify CALLBACK_AMOUNT format
        if(!error && tokenInfo && !this.util.isNull(tokenInfo['CALLBACK_AMOUNT']) && !this.util.isValidAmountFormat(parseInt(callbackTokenInfo['DECIMALS']), tokenInfo['CALLBACK_AMOUNT']))
            error = 'invalid: CALLBACK_AMOUNT (format)';

        /*****************************************************************
         * General Validations
         ****************************************************************/

        // Verify CALLBACK_BLOCK is less than or equal to current block index
        if(!error && tokenInfo && !this.util.isNull(tokenInfo['CALLBACK_BLOCK']) && tokenInfo['CALLBACK_BLOCK'] > data['BLOCK_INDEX'])
            error = 'invalid: CALLBACK_BLOCK (block index)';

        // Verify no pipe in MEMO (pipe is field delimiter)
        if(!error && !this.util.isNull(data['MEMO']) && String(data['MEMO']).indexOf('|')!=-1)
            error = 'invalid: MEMO (pipe)';

        // Verify no semicolon in MEMO (semicolon is action delimiter)
        if(!error && !this.util.isNull(data['MEMO']) && String(data['MEMO']).indexOf(';')!=-1)
            error = 'invalid: MEMO (semicolon)';

        // Verify SOURCE has enough balances to cover CALLBACK_TICK total amount
        if(!error && !this.util.hasBalance(balances, callbackTokenInfo['TICK_ID'], totalCallbackTickAmount))
            error = 'invalid: insufficient funds (CALLBACK_TICK)';
    
        // Adjust balances to reduce by CALLBACK_TICK total amount
        if(!error)
            balances = this.util.debitBalances(balances, callbackTokenInfo['TICK_ID'], totalCallbackTickAmount);

        // Verify SOURCE has enough balances to cover FEE AMOUNT
        if(!error && !this.util.hasBalance(balances, fees['TICK_ID'], fees['AMOUNT']))
            error = 'invalid: insufficient funds (FEE)';

        // Adjust balances to reduce by FEE AMOUNT
        if(!error)
            balances = this.util.debitBalances(balances, fees['TICK_ID'], fees['AMOUNT']);

        // Determine final status
        let status = (error) ? error : 'valid';
        data['STATUS'] = callback['STATUS'] = status;

        // Print status message 
        console.log("\t CALLBACK : " + data['TICK'] + ' : '  +  data['MEMO'] + ' : ' + data['STATUS']);

        // Create record in callback table
        await this.indexerDb.createCallback(callback);

        // If this was a valid transaction, then create the credit and debit records
        if(status=='valid'){

            // Array of credits and debits (tick, amount, address)
            let credits = [],
                debits  = [];

            // Store the SOURCE and TICK in addresses list
            this.util.addAddressTicker(data['SOURCE'], fees['TICK']);

            // Loop through list of holders 
            for(let address in holders){

                // Ignore the source address so it is not debited what it is holding
                if(address==data['SOURCE'])
                   continue;

                // Create debit record to callback the TICK to SOURCE
                debits.push([callback['TICK'], holders[address], address]);

                // Store the holder ADDRESS and TICK in addresses list
                this.util.addAddressTicker(address, callback['TICK']);
            }

            // Create credit record for TICK total to SOURCE
            credits.push([callback['TICK'], totalTickAmount, callback['SOURCE']]);

            // Create debit record for CALLBACK_TICK total from SOURCE
            debits.push([callback['CALLBACK_TICK'], totalCallbackTickAmount, callback['SOURCE']]);

            // Handle any transaction FEE according the users's ADDRESS preferences
            [credits, debits] = await this.util.processTransactionFees(this.indexerDb, credits, debits, fees);

            // Loop through recipient addresses
            for(let address in recipients){

                // Store the recipient ADDRESS and TICK in addresses list
                this.util.addAddressTicker(address, callback['CALLBACK_TICK']);
    
                // Credit address with CALLBACK_TICK AMOUNT
                credits.push([callback['CALLBACK_TICK'], recipients[address], address]);
            }

            // Process any transaction credit/debit records
            await this.util.processTransactionCreditsDebits(this.indexerDb, credits, debits, data);

            // Get a list of tickers from this callback
            let tickers = this.util.getTickersList();

            // Get a list of addresses associated with this callback
            let addresses = Object.keys(this.util.getAddressesList());

            // Update balances for addresses
            await this.indexerDb.updateBalances(addresses);

        }
    }
}

module.exports = Callback;