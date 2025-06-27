/*********************************************************************
 * XChain Platform Action - SWAP
 * 
 * This action allows for swapping tokens across XChain platform supported blockchains.
 * 
 * PARAMS:
 * - VERSION           -  Format Version
 * - GIVE_COIN         -  `COIN` name (BTC, LTC, DOGE, etc)
 * - GIVE_TICK         -  Ticker name or Ticker ID
 * - GIVE_AMOUNT       -  Quantity of `GIVE_TICK` to escrow in the swap
 * - GET_COIN          -  `COIN` name (BTC, LTC, DOGE, etc)
 * - GET_TICK          -  Ticker name or Ticker ID
 * - GET_AMOUNT        -  Quantity of `GET_TICK` requested in return
 * - GET_ADDRESS       -  Address to receive `GET_TICK` on `GET_COIN` network
 * - EXPIRATION        -  Timestamp of when swap should expire, in Unix time
 * - ALLOW_LIST        - `ACTION_INDEX` of a `LIST` of addresses allowed to match swap
 * - BLOCK_LIST        - `ACTION_INDEX` of a `LIST` of addresses NOT allowed to match swap
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
        this.formats[0] = 'VERSION|GIVE_COIN|GIVE_TICK|GIVE_AMOUNT|GET_COIN|GET_TICK|GET_AMOUNT|GET_ADDRESS|EXPIRATION|ALLOW_LIST|BLOCK_LIST|MEMO';
        this.formats[1] = 'VERSION|SWAP_ACTION_INDEX|MEMO';
        this.formats[2] = 'VERSION|SWAP_ACTION_INDEX|EXPIRATION|ALLOW_LIST|BLOCK_LIST|MEMO';

        // Define array of acceptable list types (2=Address)
        this.listTypes = [2];

        // Define lists of various fields
        this.fieldList = {};

        // Define list of NUMBER fields (used to convert values from string to number)
        this.fieldList['NUMBER'] = ['GIVE_AMOUNT', 'GET_AMOUNT', 'EXPIRATION', 'ALLOW_LIST', 'BLOCK_LIST', 'SWAP_ACTION_INDEX'];

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

        // Convert NUMBER fields from string value to number value so comparisons are mathematical 
        for(let name of this.fieldList['NUMBER']){
            let value = data[name];
            if(!this.util.isNull(value))
                data[name] = this.util.bcnum(value);
        }

        // Get information on the GIVE and GET tokens
        let giveTokenInfo = false;
        let getTokenInfo  = false;
        if(format==0){
            giveTokenInfo = await this.indexerDb.getTokenInfo(data['GIVE_TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX']);
            if(data['GET_COIN']==this.config['COIN']){
                getTokenInfo = await this.indexerDb.getTokenInfo(data['GET_TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX']);
            } else {
                // TODO : add code to xchain-hub to validate that GET_TICK is valid on GET_COIN, and if not, mark as invalid
            }
        }

        // Get information on a swap given the COIN network and SWAP_ACTION_INDEX
        var swapInfo = false;
        if(format==1 || format==2)
            swapInfo = await this.indexerDb.getSwapInfo(this.config['COIN'], data['SWAP_ACTION_INDEX'])

        // Get source address balances and preferences
        let balances    = await this.indexerDb.getAddressBalances(data['SOURCE'], null, data['BLOCK_INDEX'], data['ACTION_INDEX']);
        let preferences = await this.indexerDb.getAddressPreferences(data['SOURCE'], data['BLOCK_INDEX'], data['ACTION_INDEX']);

        // Create the fees object 
        let fees = this.util.createFeesObject(data, preferences);

        // Default GET_ADDRESS to SOURCE address if COIN networks are the same and GET_ADDRESS is not given
        if(this.config['COIN']==data['GET_COIN'] && this.util.isNull(data['GET_ADDRESS']))
            data['GET_ADDRESS'] = data['SOURCE'];

        // Clone the raw data for storage in swap table
        let swap = structuredClone(data);

        /*****************************************************************
         * TICK & COIN Validations
         ****************************************************************/

        // Validate GIVE_COIN is valid
        if(!error && format==0 && !this.config['COINS'].includes(data['GIVE_COIN']))
            error = 'invalid: GIVE_COIN (unsupported COIN network)';

        // Validate GET_COIN is valid
        if(!error && format==0 && !this.config['COINS'].includes(data['GET_COIN']))
            error = 'invalid: GET_COIN (unsupported COIN network)';

        // validate GIVE_COIN network is current COIN network
        if(!error && format==0 && this.config['COIN']!=data['GIVE_COIN'])
            error = "invalid: GIVE_COIN (network)";

        // Validate GIVE_TICK exists
        if(!error && format==0 && !giveTokenInfo)
            error = 'invalid: GIVE_TICK (unknown)';

        // Validate GET_TICK exists
        if(!error && format==0 && !getTokenInfo)
            error = 'invalid: GET_TICK (unknown)';

        /*****************************************************************
         * FORMAT Validations
         ****************************************************************/

        // Set token divisibility based on token DECIMAL property (if it exists)
        let giveTickDivisible = (giveTokenInfo['DECIMALS]']==0) ? 0 : 1;
        let getTickDivisible  = (getTokenInfo['DECIMALS]']==0) ? 0 : 1;

        // Verify GIVE_AMOUNT format
        if(!error && format==0 && !this.util.isNull(data['GIVE_AMOUNT']) && !this.util.isValidAmountFormat(giveTickDivisible, data['GIVE_AMOUNT']))
            error = "invalid: GIVE_AMOUNT (format)";

        // Verify GET_AMOUNT format
        if(!error && format==0 && !this.util.isNull(data['GET_AMOUNT']) && !this.util.isValidAmountFormat(getTickDivisible, data['GET_AMOUNT']))
            error = "invalid: GET_AMOUNT (format)";

        // Verify GET_ADDRESS is given if COIN network differs from GET_COIN network
        if(!error && format==0 && this.config['COIN']!=data['GET_COIN'] && this.util.isNull(data['GET_ADDRESS']))
            error = "invalid: GET_ADDRESS";

        // Verify GET_ADDRESS is valid for the given GET_COIN network
        if(!error && format==0 && !this.util.isNull(data['GET_ADDRESS']) && !this.util.isCryptoAddress(data['GET_ADDRESS']))
            error = "invalid: GET_ADDRESS (format)";

        // Validate that EXPIRATION is an integer
        if(!error && (format==0 || format==2) && (this.util.isNull(data['EXPIRATION']) || !this.util.isNumeric(data['EXPIRATION']) || !this.util.isInteger(data['EXPIRATION'])))
            error = "invalid: EXPIRATION (format)";

        /*****************************************************************
         * General Validations
         ****************************************************************/

        // Verify SOURCE is allowed to perform action
        if(!error && !await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']))
            error = 'invalid: SOURCE (sleeping)';

        // Verify TICK is allowed to perform action
        if(!error && format==0 && !await this.indexerDb.isActionAllowed(null, data['GIVE_TICK'], data['BLOCK_INDEX']))
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
        if(!error && format==0 && !await this.indexerDb.isActionAllowed(data['SOURCE'], data['GIVE_TICK']))
            error = 'invalid: SOURCE (not authorized)';

        // Validate SWAP_ACTION_INDEX is valid SWAP
        if(!error && (format==1 || format==2) && !swapInfo)
            error = 'invalid: SWAP_ACTION_INDEX (unknown)';

        // Verify SOURCE address is owner of the SWAP_ACTION_INDEX swap
        if(!error && (format==1 || format==2) && data['SOURCE']!=swapInfo['SOURCE'])
            error = 'invalid: SOURCE (not owner)';

        // Validate SWAP_ACTION_INDEX is valid SWAP with a status of open
        if(!error && (format==1 || format==2) && swapInfo['SWAP_STATUS']!='open')
            error = 'invalid: SWAP_ACTION_INDEX (swap not open)';

        // Validate that EXPIRATION is in the future (unixtime is in seconds, not milliseconds)
        if(!error && !this.util.isNull(data['EXPIRATION']) && data['EXPIRATION'] <= Math.floor(Date.now() / 1000))
            error = "invalid: EXPIRATION (past)";

        // Validate LIST fields (ALLOW_LIST / BLOCK_LIST)
        if(!error){
            for(let name of this.config['LIST_FIELDS']){
                if(!error && !this.util.isNull(data[name]) && this.util.isNumeric(data[name])){
                    // Get LIST type and information
                    let type = await this.indexerDb.getListType(data[name]);

                    // Verify LIST exist
                    if(!error && type===false)
                        error = 'invalid: ' + name + ' (unknown)';

                    // Verify LIST type is supported
                    if(!error && !this.listTypes.includes(type))
                        error = 'invalid: ' + name + ' (unsupported)';
                }
            }
        }

        // Verify SOURCE has enough balances to cover GIVE_AMOUNT
        if(!error && format==0 && !this.util.hasBalance(balances, giveTokenInfo['TICK_ID'], data['GIVE_AMOUNT']))
            error = 'invalid: insufficient funds (GIVE_AMOUNT)';

        // Adjust balances to reduce by SWAP GIVE_AMOUNT
        if(!error && format==0)
            balances = this.util.debitBalances(balances, giveTokenInfo['TICK_ID'], data['GIVE_AMOUNT']);

        // Calculate total fee for this swap based on EXPIRATION timestamp
        fees['AMOUNT'] = 0;

        // Calculate the fee to charge based on the EXPIRATION
        if(!error && (format==0 || format==2) && !this.util.isNull(data['EXPIRATION'])){
            // Create Swap
            if(format==0){
                let expire_seconds = this.util.bcsub(data['EXPIRATION'],data['BLOCK_TIME'], 0);
                let expire_days    = this.util.bcdiv(expire_seconds, 86400, 0);
                fees['AMOUNT'] = (expire_days > this.config['EXPIRATION_FEE_FREE_DAYS']) ? (this.util.bcmul(expire_days, this.config['EXPIRATION_FEE_PER_DAY'],8)) : 0;
            }
            // Edit Swap
            if(format==2 && data['EXPIRATION'] > swapInfo['EXPIRATION']){
                let orig_expire_seconds = this.util.bcsub(swapInfo['EXPIRATION'],swapInfo['BLOCK_TIME'], 0);
                let orig_expire_days    = this.util.bcdiv(orig_expire_seconds, 86400, 0);
                let edit_expire_seconds = this.util.bcsub(data['EXPIRATION'],swapInfo['BLOCK_TIME'], 0);
                let edit_expire_days    = this.util.bcdiv(edit_expire_seconds, 86400, 0);
                // Only calculate FEE if increasing EXPIRATION date and greater than EXPIRATION_FEE_FREE_DAYS
                if(data['EXPIRATION'] > swapInfo['EXPIRATION'] && edit_expire_days > this.config['EXPIRATION_FEE_FREE_DAYS']){
                    let expire_days = this.util.bcsub(edit_expire_days, orig_expire_days, 0);
                    fees['AMOUNT']  = this.util.bcmul(expire_days, this.config['EXPIRATION_FEE_PER_DAY'],8);
                }
            }
        }

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

        // Print status message
        if(format==0)
            console.log("\t SWAP : " + data['GIVE_AMOUNT'] + ' ' + this.config['COIN'] + ':' + data['GIVE_TICK'] + ' = '  +  data['GET_AMOUNT'] + ' ' + data['GET_COIN'] + ':' + data['GET_TICK'] + ' : ' + data['STATUS']);
        if(format==1)
            console.log("\t SWAP (cancel): " + this.config['COIN'] + ':' + data['SWAP_ACTION_INDEX'] + ' : ' + data['STATUS']);
        if(format==2)
            console.log("\t SWAP (edit): " + this.config['COIN'] + ':' + data['SWAP_ACTION_INDEX'] + ' : ' + data['EXPIRATION'] + ' : ' + data['STATUS']);

        // Create record in swaps table
        if(format==0)
            await this.indexerDb.createSwap(swap);

        // Update action from SWAP to SWAP_CANCEL and create record in swap_cancels table
        if(format==1){
            await this.indexerDb.updateActionIndex(data['ACTION_INDEX'], 'SWAP_CANCEL');
            await this.indexerDb.createSwapCancel(swap);
        }

        // Update action from SWAP to SWAP_EDIT and create record in swap_edits table
        if(format==2){
            await this.indexerDb.updateActionIndex(data['ACTION_INDEX'], 'SWAP_EDIT');
            await this.indexerDb.createSwapEdit(swap);
        }

        // If this was a valid transaction, add GIVE_AMOUNT to escrow
        if(status=='valid'){

            // Array of credits, debits, and escrows
            let credits = [],
                debits  = [],
                escrows = [];

            // Format 0 - Create Swap
            if(format==0){
                // Store the SOURCE, GIVE_TICK, and fees TICK in addresses list
                this.util.addAddressTicker(data['SOURCE'], [data['GIVE_TICK'], fees['TICK']]);

                // Debit GIVE_AMOUNT of GIVE_TICK from SOURCE
                debits.push([data['GIVE_TICK'], data['GIVE_AMOUNT'], data['SOURCE']]);

                // Escrow GIVE_AMOUNT of GIVE_TICK from SOURCE
                escrows.push([data['GIVE_TICK'], data['GIVE_AMOUNT'], data['SOURCE']]);

                // Create record in the swaps_statuses table
                await this.indexerDb.createSwapStatus(data['ACTION_INDEX'], data['ACTION_INDEX'], 'open');
            }

            // Format 1 - Cancel Swap
            // TODO: Update code to only credit back what remains escrowed, not entire amount (will cause sanity error in current format)
            if(format==1){
                // Store the SOURCE and GIVE_TICK in addresses list
                this.util.addAddressTicker(swapInfo['SOURCE'], swapInfo['GIVE_TICK']);

                // Debit GIVE_AMOUNT of GIVE_TICK from escrow
                await this.indexerDb.removeEscrowRecord(swapInfo['ACTION_INDEX']);

                // Credit GIVE_AMOUNT of GIVE_TICK to SOURCE
                credits.push([swapInfo['GIVE_TICK'], swapInfo['GIVE_AMOUNT'], swapInfo['SOURCE']]);

                // Create record in the swaps_statuses table
                await this.indexerDb.createSwapStatus(data['ACTION_INDEX'], swapInfo['ACTION_INDEX'], 'cancelled');
            }

            // Format 2 - Edit swap (EXPIRATION)
            if(format==2){
                // Store the SOURCE and fees TICK in addresses list
                this.util.addAddressTicker(data['SOURCE'], fees['TICK']);
            }

            // Handle any transaction FEE according the users's ADDRESS preferences
            [credits, debits] = await this.util.processTransactionFees(this.indexerDb, credits, debits, fees);

            // Process any transaction ledger changes (credits / debits / escrows)
            await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits, escrows);

            /*****************************************************************
             * SWAP Matching Validations
             ****************************************************************/

            // Get a list of any matching open swaps
            let matches = await this.indexerDb.getSwapMatches(data);
            if(matches){
                // Get information on the tokens involved in the swap
                let getTokenInfo  = await this.indexerDb.getTokenInfo(data['GET_TICK'],  data['BLOCK_INDEX'], data['ACTION_INDEX']);
                let giveTokenInfo = await this.indexerDb.getTokenInfo(data['GIVE_TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX']);

                // List of addresses allowed or blocked from holding GET_TICK
                let getTokenAllowList = (getTokenInfo['ALLOW_LIST']) ? await this.indexerDb.getList(getTokenInfo['ALLOW_LIST']) : false;
                let getTokenBlockList = [getTokenInfo['BLOCK_LIST']] ? await this.indexerDb.getList(getTokenInfo['BLOCK_LIST']) : false;

                // List of addresses allowed or blocked from holding GIVE_TICK
                let giveTokenAllowList = (giveTokenInfo['ALLOW_LIST']) ? await this.indexerDb.getList(giveTokenInfo['ALLOW_LIST']) : false;
                let giveTokenBlockList = [giveTokenInfo['BLOCK_LIST']] ? await this.indexerDb.getList(giveTokenInfo['BLOCK_LIST']) : false;

                // List of addresses allowed or blocked from matching with this SWAP
                let swapInfoAllowList = (swapInfo['ALLOW_LIST']) ? await this.indexerDb.getList(swapInfo['ALLOW_LIST']) : false;
                let swapInfoBlockList = [swapInfo['BLOCK_LIST']] ? await this.indexerDb.getList(swapInfo['BLOCK_LIST']) : false;

                // Loop through matches and determine if we have a valid match
                let match = false;
                for(let swap of matches){
                    let valid = true;

                    // List of addresses allowed or blocked from matching with this matching SWAP
                    let matchInfoAllowList = (swap['ALLOW_LIST']) ? await this.indexerDb.getList(swap['ALLOW_LIST']) : false;
                    let matchInfoBlockList = [swap['BLOCK_LIST']] ? await this.indexerDb.getList(swap['BLOCK_LIST']) : false;

                    // Check if GET_ADDRESS for both sides of swap are allowed (ALLOW/BLOCK list support)
                    if((getTokenAllowList.length  && (!getTokenAllowList.includes(data['GET_ADDRESS'])  || !getTokenAllowList.includes(swap['GET_ADDRESS'])))  ||
                       (getTokenBlockList.length  && ( getTokenBlockList.includes(data['GET_ADDRESS'])  ||  getTokenBlockList.includes(swap['GET_ADDRESS'])))  ||
                       (giveTokenAllowList.length && (!giveTokenAllowList.includes(data['GET_ADDRESS']) || !giveTokenAllowList.includes(swap['GET_ADDRESS']))) ||
                       (giveTokenBlockList.length && ( giveTokenBlockList.includes(data['GET_ADDRESS']) ||  giveTokenBlockList.includes(swap['GET_ADDRESS']))) ||
                       (swapInfoAllowList.length  && !swapInfoAllowList.includes(swap['GET_ADDRESS']))  ||
                       (swapInfoBlockList.length  &&  swapInfoBlockList.includes(swap['GET_ADDRESS']))  || 
                       (matchInfoAllowList.length && !matchInfoAllowList.includes(data['GET_ADDRESS'])) ||
                       (matchInfoBlockList.length &&  matchInfoBlockList.includes(data['GET_ADDRESS']))){
                        valid = false;
                    }

                    // If we found a valid match, stop looking for additional matches
                    if(valid){
                        match = swap;
                        break;
                    }
                }

                // Process the swap match
                // TODO : Revisit this code once multi-chain swap support is added to xchain-hub component
                if(match){
                    // Reset credits, debits, and escrow arrays
                    credits = [],
                    debits  = [],
                    escrows = [];

                    // Define SWAP_MATCH action
                    let action = {}
                    action['BLOCK_INDEX'] = data['BLOCK_INDEX'];
                    action['TX_INDEX']    = data['TX_INDEX']
                    action['ACTION']      = 'SWAP_MATCH';

                    // Create a record of this SWAP_MATCH action in the actions table
                    data['ACTION_INDEX'] = await this.indexerDb.createActionIndex(action);

                    // Store the SOURCE and GET_TICK in addresses list
                    this.util.addAddressTicker(match['SOURCE'], match['GET_TICK']);

                    // Credit tokens to GET_ADDRESS in swaps
                    credits.push([match['GET_TICK'], match['GET_AMOUNT'], match['GET_ADDRESS']]);
                    credits.push([data['GET_TICK'],  data['GET_AMOUNT'],  data['GET_ADDRESS']]);

                    // Debit tokens from escrows table 
                    escrows.push([match['GET_TICK'], -match['GET_AMOUNT'], data['SOURCE']]);
                    escrows.push([data['GET_TICK'],  -data['GET_AMOUNT'],  match['SOURCE']]);

                    // Store the GET_ADDRESS and TICK in addresses list
                    this.util.addAddressTicker(match['GET_ADDRESS'], match['GET_TICK']);
                    this.util.addAddressTicker(data['GET_ADDRESS'],  data['GET_TICK']);

                    // Process any transaction ledger changes (credits / debits / escrows)
                    await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits, escrows);

                    // Create record of match in swap_matches table
                    await this.indexerDb.createSwapMatch(data['ACTION_INDEX'], swap, match, 'valid');

                    // Update record in swaps table to change status (open->complete)
                    await this.indexerDb.createSwapStatus(data['ACTION_INDEX'], swap['ACTION_INDEX'],  'complete');
                    await this.indexerDb.createSwapStatus(data['ACTION_INDEX'], match['ACTION_INDEX'], 'complete');
                }
            }

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

        }

    }
}

module.exports = Swap;