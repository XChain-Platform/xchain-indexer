/*********************************************************************
 * XChain Indexer ACTION - DESTROY
 * 
 * PARAMS:
 * - VERSION - Broadcast Format Version
 * - TICK    - 1 to 250 characters in length
 * - AMOUNT  - Amount of tokens to destroy
 * - MEMO    - An optional memo to include     
 * 
 * FORMATS:
 * - 0 = Single Destroy
 * - 1 = Multi-Destroy (Full)
 * - 2 = Multi-Destroy (Full) with Multiple Memos
 * 
 ********************************************************************/

class Destroy {

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
        this.formats[0] = 'VERSION|TICK|AMOUNT|MEMO';
        this.formats[1] = 'VERSION|TICK|AMOUNT|TICK|AMOUNT|MEMO';
        this.formats[2] = 'VERSION|TICK|AMOUNT|MEMO|TICK|AMOUNT|MEMO';

        // Define lists of various fields
        this.fieldList = {};

        // Define list of NUMBER fields (used to convert values from string to number)
        this.fieldList['NUMBER'] = ['AMOUNT'];

    }

    // Handle parsing the DESTROY transaction
    async parse(params, data, error){
        /*****************************************************************
         * DEBUGGING - Force params
         ****************************************************************/
        // let str = '0|BRRR|1|foo';
        // let str = '1|BRRR|1|GAS|10|bar';
        // let str = '2|BRRR|1|foo|GAS|10|bar';
        // params = String(str).split('|');

        // Reset the address/tickers/transactions list on each parse
        this.util.resetLists();

        // Validate that format is known
        let format = this.util.getFormatVersion(params[0]);
        if(!error && (format===null || this.formats[format] === undefined ))
            error = 'invalid: VERSION (unknown)';

        // Array of destroys [TICK, AMOUNT, MEMO]
        let destroys = []; 

        // Extract memo
        let memo = null;
        let last = params.length - 1;
        for(let idx in params)
            if(idx==last && ((format==0 && idx==3) || (format==1 && idx%2==1)))
                memo = params[idx];

        // If we encountered an invalid version error add it to the destroys list so we create a record of it in destroys
        if(error)
            destroys.push([params[0], params[1], memo]);

        // Build out array of destroys
        let lastIdx = params.length - 1;
        for(let idx in params){
            // Force index to integer value
            idx = parseInt(idx);

            // Single Destroy
            if(format==0 && idx==0)
                destroys.push([params[1], params[2], memo]);

            // Multi-Destroy (Full)
            if(format==1 && idx>1 && idx%2==1)
                destroys.push([params[1], params[idx-1], memo]);

            // Multi-Destroy (Full) with Multiple Memos
            if(format==2 && idx>0 && idx%3==1 && idx < lastIdx)
                destroys.push([params[idx], params[(idx+1)], params[idx+2], params[idx+3]]);
        }

        // Get token data for every TICK (reduces duplicated sql queries)
        let ticks = {};
        for(let destroy of destroys){
            let tick = destroy[0];
            if(!ticks[tick])
                ticks[tick] = await this.indexerDb.getTokenInfo(tick, null, data['BLOCK_INDEX'], data['ACTION_INDEX']);
        }

        // Consolidate destroys by TICK and MEMO
        let keys = {};
        for(let info of destroys){
            let [tick, amount, memo] = info;
            let key = tick + '|' + memo;
            if(!this.util.isNull(keys[key]))
                amount = this.util.bcadd(amount, keys[key][1], ticks[tick]['DECIMALS']);
            keys[key] = [tick, amount, memo];
        }

        // Update destroys using consolidated info
        destroys = [];
        for(let key in keys)
            destroys.push(keys[key]);

        // Get source address balances
        let balances = await this.indexerDb.getAddressBalances(data['SOURCE'], null, data['BLOCK_INDEX'], data['ACTION_INDEX']);

        // Store original error value
        let origError = error;

        // Array of credits and debits
        let credits = [],
            debits  = [];

        // Loop through destroys and process each
        for(let idx in destroys){

            // Parse in the destroy information
            let info = destroys[idx];

            // Reset error to the original value
            error = origError;

            // Copy base transaction data object
            let destroy = data;

            // Update transaction data object with destroy values
            destroy['TICK']   = info[0];
            destroy['AMOUNT'] = info[1];
            destroy['MEMO']   = info[2];

            // Get information on token
            let tokenInfo = ticks[destroy['TICK']];

            /*****************************************************************
             * TICK Validations
             ****************************************************************/

            // Validate TICK exists
            if(!error && !tokenInfo)
                error = 'invalid: TICK (unknown)';

            // Determine token divisibility
            let divisible = (tokenInfo && tokenInfo['DECIMALS']>=1) ? 1 : 0;

            /*************************************************************
             * FORMAT Validations
             ************************************************************/

            // Verify AMOUNT format
            if(!error && !this.util.isNull(destroy['AMOUNT']) && !this.util.isValidAmountFormat(divisible, destroy['AMOUNT']))
                error = "invalid: AMOUNT (format)";

            /*************************************************************
             * General Validations
             ************************************************************/

            // Verify no pipe in MEMO (pipe is field delimiter)
            if(!error && String(destroy['MEMO']).indexOf('|')!=-1)
                error = 'invalid: MEMO (pipe)';

            // Verify no semicolon in MEMO (semicolon is action delimiter)
            if(!error && String(destroy['MEMO']).indexOf(';')!=-1)
                error = 'invalid: MEMO (semicolon)';

            // Verify action is allowed from SOURCE (ALLOW_LIST & BLOCK_LIST)
            if(!error && !this.indexerDb.isActionAllowed(destroy['TICK'], destroy['SOURCE']))
                error = 'invalid: SOURCE (not authorized)';

            // Verify SOURCE has enough balances to cover destroy
            if(!error && !this.util.hasBalance(balances, tokenInfo['TICK_ID'], destroy['AMOUNT']))
                error = 'invalid: insufficient funds';

            // Adjust balances to reduce by DESTROY AMOUNT
            if(!error)
                balances = this.util.debitBalances(balances, tokenInfo['TICK_ID'], destroy['AMOUNT']);

            // Determine final status
            let status = (error) ? error : 'valid';
            data['STATUS'] = destroy['STATUS'] = status;
    
            // Print status message 
            console.log("\t DESTROY : " + destroy['TICK'] + ' : ' + destroy['AMOUNT'] + ' : ' + destroy['MEMO'] + ' : '+ data['STATUS']);
    
            // Create record in destroys table
            await this.indexerDb.createDestroy(destroy);
    
            // If this was a valid transaction, then add records to the credits and debits array
            if(status=='valid'){

                // Store the SOURCE and TICK in addresses list
                this.util.addAddressTicker(destroy['SOURCE'], destroy['TICK']);

                // Add ticker and amount to debits array
                debits.push([destroy['TICK'], destroy['AMOUNT'], destroy['SOURCE']]);

            }
        }

        // Process any transaction credit/debit records
        await this.util.processTransactionCreditsDebits(this.indexerDb, credits, debits, data);

        // TODO: If this is a reparse, bail out before updating balances and token information
        // if(reparse)
        //     return;

        // Get a list of tickers from this destroy
        let tickers = Object.keys(ticks);

        // Get a list of addresses associated with this destroy
        let addresses = Object.keys(this.util.getAddressesList());

        // Update balances for addresses
        await this.indexerDb.updateBalances(addresses);

        // Update supplies for tokens
        await this.indexerDb.updateTokenInfo(tickers);

    }
}

module.exports = Destroy;