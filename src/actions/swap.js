/*********************************************************************
 * XChain Platform Action - SWAP
 * 
 * This action allows for swapping tokens across XChain platform supported blockchains.
 * 
 * PARAMS:
 * - VERSION           -  Format Version
 * - GIVE_TICK         -  Ticker name or Ticker ID
 * - GIVE_AMOUNT       -  Quantity of `GIVE_TICK` to escrow in the swap
 * - GET_COIN          -  `COIN` name (BTC, LTC, DOGE, etc)
 * - GET_TICK          -  Ticker name or Ticker ID
 * - GET_AMOUNT        -  Quantity of `GET_TICK` requested in return
 * - EXPIRATION        -  Timestamp of when swap should expire, in Unix time
 * - MEMO              -  An optional memo to include
 * - SWAP_ACTION_INDEX -  `ACTION_INDEX` of existing `SWAP`
 * 
 * FORMATS:
 * - 0 = Create Swap
 * - 1 = Cancel Swap
 * - 2 = Edit Swap
 *
 ********************************************************************/

class Swap {

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
        this.formats[0] = 'VERSION|GIVE_TICK|GIVE_AMOUNT|GET_COIN|GET_TICK|GET_AMOUNT|EXPIRATION|MEMO';
        this.formats[1] = 'VERSION|SWAP_ACTION_INDEX|MEMO';
        this.formats[2] = 'VERSION|SWAP_ACTION_INDEX|EXPIRATION|MEMO';

        // Define lists of various fields
        this.fieldList = {};

        // Define list of NUMBER fields (used to convert values from string to number)
        this.fieldList['NUMBER'] = ['GIVE_AMOUNT', 'GET_AMOUNT', 'EXPIRATION', 'SWAP_ACTION_INDEX'];

    }

    // Handle parsing the SWAP transaction
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

        // Clone the raw data for storage in swap table
        let swap = structuredClone(data);

        // Convert NUMBER fields from string value to number value so comparisons are mathematical 
        for(let name of this.fieldList['NUMBER']){
            let value = data[name];
            if(!this.util.isNull(value))
                data[name] = this.util.bcnum(value);
        }

        // Get information on the GIVE token
        let giveTokenInfo = await this.indexerDb.getTokenInfo(data['GIVE_TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX']);

        // Get information on the GET token
        let getTokenInfo = false;
        if(data['GET_COIN']==this.config['COIN']){
            getTokenInfo = await this.indexerDb.getTokenInfo(data['GET_TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX']);
        } else {
            // TODO : Add code here to get GET token from different COIN network
        }

        // Get source address balances and preferences
        let balances    = await this.indexerDb.getAddressBalances(data['SOURCE'], null, data['BLOCK_INDEX'], data['ACTION_INDEX']);
        let preferences = await this.indexerDb.getAddressPreferences(data['SOURCE'], data['BLOCK_INDEX'], data['ACTION_INDEX']);

        // Create the fees object 
        let fees = this.util.createFeesObject(data, preferences);

        /*****************************************************************
         * TICK & COIN Validations
         ****************************************************************/

        // Validate GET_COIN is valid
        if(!error && !this.config['COINS'].includes(data['GET_COIN']))
            error = 'invalid: GIVE_COIN (unsupported COIN network)';

        // Validate GIVE_TICK exists
        if(!error && !giveTokenInfo)
            error = 'invalid: GIVE_TICK (unknown)';

        // Validate GET_TICK exists
        if(!error && !getTokenInfo)
            error = 'invalid: GET_TICK (unknown)';

        /*****************************************************************
         * FORMAT Validations
         ****************************************************************/

        // Set token divisibility based on token DECIMAL property (if it exists)
        let giveTickDivisible = (giveTokenInfo['DECIMALS]']==0) ? 0 : 1;
        let getTickDivisible  = (getTokenInfo['DECIMALS]']==0) ? 0 : 1;

        // Verify GIVE_AMOUNT format
        if(!error && !this.util.isNull(data['GIVE_AMOUNT']) && !this.util.isValidAmountFormat(giveTickDivisible, data['GIVE_AMOUNT']))
            error = "invalid: GIVE_AMOUNT (format)";

        // Verify GET_AMOUNT format
        if(!error && !this.util.isNull(data['GET_AMOUNT']) && !this.util.isValidAmountFormat(getTickDivisible, data['GET_AMOUNT']))
            error = "invalid: GET_AMOUNT (format)";

        // Validate that EXPIRATION is an integer
        if(!error && (this.util.isNull(data['EXPIRATION']) || !this.util.isNumeric(data['EXPIRATION']) || !this.util.isInteger(data['EXPIRATION'])))
            error = "invalid: EXPIRATION (format)";

        /*****************************************************************
         * General Validations
         ****************************************************************/

        // Verify SOURCE is allowed to perform action
        if(!error && !await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']))
            error = 'invalid: SOURCE (sleeping)';

        // Verify TICK is allowed to perform action
        if(!error && !await this.indexerDb.isActionAllowed(null, data['GIVE_TICK'], data['BLOCK_INDEX']))
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

        // Verify TICK action is allowed from SOURCE (allow/block lists)
        if(!error && !await this.indexerDb.isActionAllowed(data['SOURCE'], data['GIVE_TICK']))
            error = 'invalid: SOURCE (not authorized)';

        // Validate that EXPIRATION is in the future (unixtime is in seconds, not milliseconds)
        if(!error && !this.util.isNull(data['EXPIRATION']) && data['EXPIRATION'] <= Math.floor(Date.now() / 1000))
            error = "invalid: EXPIRATION (past)";

        // Verify SOURCE has enough balances to cover GIVE_AMOUNT
        if(!error && !this.util.hasBalance(balances, giveTokenInfo['TICK_ID'], data['GIVE_AMOUNT']))
            error = 'invalid: insufficient funds (GIVE_AMOUNT)';
    
        // Adjust balances to reduce by SWAP GIVE_AMOUNT
        if(!error)
            balances = this.util.debitBalances(balances, giveTokenInfo['TICK_ID'], data['GIVE_AMOUNT']);

        // Calculate total fee for this swap based on EXPIRATION timestamp
        let expire_seconds = this.util.bcsub(data['EXPIRATION'],data['BLOCK_TIME'], 0); // expiration - current time = expire in X seconds
        let expire_days    = this.util.bcdiv(expire_seconds, 86400, 0);                 // 86400 seconds in a day
        console.log('expire_days=',expire_days);
        // let db_hits = 1;                                                                               // 1 swa
        //     db_hits += (data['BALANCES']) ? this.util.bcmul(Object.keys(balances).length,4,0) : 0;     // 1 debits, 1 credits, 2 balances
        //     db_hits += (data['OWNERSHIPS']) ? this.util.bcmul(Object.keys(ownerships).length,2,0) : 0; // 1 issue, 1 tokens

        // Determine total transaction FEE based on database hits
        fees['AMOUNT'] = 1;

        // Verify SOURCE has enough balances to cover FEE AMOUNT
        if(!error && !this.util.hasBalance(balances, fees['TICK_ID'], fees['AMOUNT']))
            error = 'invalid: insufficient funds (FEE)';

        // Adjust balances to reduce by FEE AMOUNT
        if(!error)
            balances = this.util.debitBalances(balances, fees['TICK_ID'], fees['AMOUNT']);

        // Determine final status
        let status = (error) ? error : 'valid';
        data['STATUS'] = swap['STATUS'] = status;

        // Set SWAP status to 'open' when creating a valid swap
        swap['SWAP_STATUS'] = (status=='valid') ? 'open' : 'invalid';

        // Print status message (1 BTC:RAREPEPE = 3 DOGE:BACON)
        console.log("\t SWAP : " + data['GIVE_AMOUNT'] + ' ' + this.config['COIN'] + ':' + data['GIVE_TICK'] + ' = '  +  data['GET_AMOUNT'] + ' ' + data['GET_COIN'] + ':' + data['GET_TICK'] + ' : ' + data['STATUS']);

        // Create record in swaps table
        await this.indexerDb.createSwap(swap);

        // If this was a valid transaction, add GIVE_AMOUNT to escrow
        if(status=='valid'){

            // Array of credits, debits, and escrows
            let credits = [],
                debits  = [],
                escrows = [];

            // Store the SOURCE, GIVE_TICK, and fees TICK in addresses list
            this.util.addAddressTicker(data['SOURCE'], [data['GIVE_TICK'], fees['TICK']]);

            // Debit GIVE_AMOUNT of GIVE_TICK from SOURCE
            debits.push([data['GIVE_TICK'], data['GIVE_AMOUNT'], data['SOURCE']]);

            // Escrow GIVE_AMOUNT of GIVE_TICK from SOURCE
            escrows.push([data['GIVE_TICK'], data['GIVE_AMOUNT'], data['SOURCE']]);

            // Handle any transaction FEE according the users's ADDRESS preferences
            [credits, debits] = await this.util.processTransactionFees(this.indexerDb, credits, debits, fees);

            // Process any transaction ledger changes (credits / debits / escrows)
            await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits, escrows);

            // If this is a reparse, bail out before updating balances and token information
            // if(reparse)
            //     return;

            // Get a list of tickers from this swap
            let tickers = this.util.getTickersList();

            // Get a list of addresses associated with this dividend
            let addresses = Object.keys(this.util.getAddressesList());

            // Update balances for addresses
            await this.indexerDb.updateBalances(addresses);

            // Update supplies for tokens
            await this.indexerDb.updateTokens(tickers);

            // TODO: Handle SWAP matching code
            // Verify both addresses are allowed to hold ticks (allow/block lists)

        }

    }
}

module.exports = Swap;