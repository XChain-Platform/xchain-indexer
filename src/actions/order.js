/*********************************************************************
 * XChain Platform Action - ORDER
 * 
 * This action creates a order to sell an item on the Decentralized Exchange (DEX).
 * 
 * PARAMS:
 * VERSION             - Format Versionz
 * GIVE_COIN           - `COIN` name (BTC, LTC, DOGE, etc)
 * GIVE_TICK           - Ticker name or Ticker ID
 * GIVE_AMOUNT         - Quantity of `GIVE_TICK` to escrow in the order
 * GET_COIN            - `COIN` name (BTC, LTC, DOGE, etc)
 * GET_TICK            - Ticker name or Ticker ID
 * GET_AMOUNT          - Quantity of `GET_TICK` requested in return
 * GET_ADDRESS         - Address to receive `GET_TICK` on `GET_COIN` network
 * EXPIRATION          - Timestamp of when order should expire, in Unix time
 * ALLOW_LIST          - `ACTION_INDEX` of a `LIST` of addresses allowed to match order
 * BLOCK_LIST          - `ACTION_INDEX` of a `LIST` of addresses NOT allowed to match order
 * MEMO                - An optional memo to include
 * ORDER_ACTION_INDEX  - `ACTION_INDEX` of existing `ORDER`
 * 
 * FORMATS:
 * - 0 = Create Order
 * - 1 = Cancel Order
 * - 2 = Edit Order
 *
 ********************************************************************/

class Order {

    // Handle constructing a class instance
    constructor(action){
        // Setup short aliases
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;
        
        // Define list of known FORMATS
        this.formats = {};
        this.formats[0] = 'VERSION|GIVE_COIN|GIVE_TICK|GIVE_AMOUNT|GET_COIN|GET_TICK|GET_AMOUNT|GET_ADDRESS|EXPIRATION|ALLOW_LIST|BLOCK_LIST|MEMO';
        this.formats[1] = 'VERSION|ORDER_ACTION_INDEX|MEMO';
        this.formats[2] = 'VERSION|ORDER_ACTION_INDEX|EXPIRATION|ALLOW_LIST|BLOCK_LIST|MEMO';

        // Define lists of various fields
        this.fieldList = {};

        // Define list of NUMBER fields (used to convert values from string to number)
        this.fieldList['NUMBER'] = ['GIVE_AMOUNT', 'GET_AMOUNT', 'EXPIRATION', 'ALLOW_LIST', 'BLOCK_LIST', 'ORDER_ACTION_INDEX'];

    }

    // Handle parsing the ORDER transaction
    async parse(params, data, error){
        /*****************************************************************
         * DEBUGGING - Force params
         ****************************************************************/
        // let str    = "0|BTC|RAREPEPE|1|BTC|PEPECASH|10000000.00000000|1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev|||Selling my RAREPEPE cuz mom in hospital";
        // let str    = "1|1234|Closing order, no buyers, much disappoint";
        // let str    = "2|1234|4321|||Updating order to only sell to club member addresses";
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

        // Get information on a order given the COIN network and ORDER_ACTION_INDEX
        var orderInfo = false;
        if(format==1 || format==2)
            orderInfo = await this.indexerDb.getOrderInfo(this.config['COIN'], data['ORDER_ACTION_INDEX'])

        // Get source address balances and preferences
        let balances    = await this.indexerDb.getAddressBalances(data['SOURCE'], null, data['BLOCK_INDEX'], data['ACTION_INDEX']);
        let preferences = await this.indexerDb.getAddressPreferences(data['SOURCE'], data['BLOCK_INDEX'], data['ACTION_INDEX']);

        // Create the fees object 
        let fees = this.util.createFeesObject(data, preferences);

        // Default GET_ADDRESS to SOURCE address if COIN networks are the same and GET_ADDRESS is not given
        if(this.config['COIN']==data['GET_COIN'] && this.util.isNull(data['GET_ADDRESS']))
            data['GET_ADDRESS'] = data['SOURCE'];

        // Clone the raw data for storage in orders table
        let order = structuredClone(data);

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

        // validate GIVE_COIN network is current COIN network
        // TODO: Remove this and allow support for cross-chain orders once xchain-hub is finished and working properly
        if(!error && format==0 && this.config['COIN']!=data['GET_COIN'])
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

        // Validate ORDER_ACTION_INDEX is valid SWAP
        if(!error && (format==1 || format==2) && !orderInfo)
            error = 'invalid: ORDER_ACTION_INDEX (unknown)';

        // Verify SOURCE address is owner of the ORDER_ACTION_INDEX order
        if(!error && (format==1 || format==2) && data['SOURCE']!=orderInfo['SOURCE'])
            error = 'invalid: SOURCE (not owner)';

        // Validate ORDER_ACTION_INDEX is valid SWAP with a status of open
        if(!error && (format==1 || format==2) && orderInfo['SWAP_STATUS']!='open')
            error = 'invalid: ORDER_ACTION_INDEX (order not open)';

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

        // Calculate total fee for this order based on EXPIRATION timestamp
        fees['AMOUNT'] = 0;

        // Calculate the fee to charge based on the EXPIRATION
        if(!error && (format==0 || format==2) && !this.util.isNull(data['EXPIRATION'])){
            // Create Order
            if(format==0){
                let expire_seconds = this.util.bcsub(data['EXPIRATION'],data['BLOCK_TIME'], 0);
                let expire_days    = this.util.bcdiv(expire_seconds, 86400, 0);
                fees['AMOUNT'] = (expire_days > this.config['EXPIRATION_FEE_FREE_DAYS']) ? (this.util.bcmul(expire_days, this.config['EXPIRATION_FEE_PER_DAY'],8)) : 0;
            }
            // Edit Order
            if(format==2 && data['EXPIRATION'] > orderInfo['EXPIRATION']){
                let orig_expire_seconds = this.util.bcsub(orderInfo['EXPIRATION'],orderInfo['BLOCK_TIME'], 0);
                let orig_expire_days    = this.util.bcdiv(orig_expire_seconds, 86400, 0);
                let edit_expire_seconds = this.util.bcsub(data['EXPIRATION'],orderInfo['BLOCK_TIME'], 0);
                let edit_expire_days    = this.util.bcdiv(edit_expire_seconds, 86400, 0);
                // Only calculate FEE if increasing EXPIRATION date and greater than EXPIRATION_FEE_FREE_DAYS
                if(data['EXPIRATION'] > orderInfo['EXPIRATION'] && edit_expire_days > this.config['EXPIRATION_FEE_FREE_DAYS']){
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
        data['STATUS'] = order['STATUS'] = status;

        // Set ORDER status to 'open' when creating a valid order
        order['ORDER_STATUS'] = (status=='valid') ? 'open' : 'invalid';

        // Print status message
        if(format==0)
            console.log("\t ORDER : " + data['GIVE_AMOUNT'] + ' ' + this.config['COIN'] + ':' + data['GIVE_TICK'] + ' = '  +  data['GET_AMOUNT'] + ' ' + data['GET_COIN'] + ':' + data['GET_TICK'] + ' : ' + data['STATUS']);
        if(format==1)
            console.log("\t ORDER (cancel): " + this.config['COIN'] + ':' + data['ORDER_ACTION_INDEX'] + ' : ' + data['STATUS']);
        if(format==2)
            console.log("\t ORDER (edit): " + this.config['COIN'] + ':' + data['ORDER_ACTION_INDEX'] + ' : ' + data['EXPIRATION'] + ' : ' + data['STATUS']);
 
        // Create record in orders table
        if(format==0)
            await this.indexerDb.createOrder(order);

        // Update action from ORDER to ORDER_CANCEL and create record in order_cancels table
        if(format==1){
            await this.indexerDb.updateActionIndex(data['ACTION_INDEX'], 'ORDER_CANCEL');
            await this.indexerDb.createOrderCancel(order);
        }

        // Update action from ORDER to ORDER_EDIT and create record in order_edits table
        if(format==2){
            await this.indexerDb.updateActionIndex(data['ACTION_INDEX'], 'ORDER_EDIT');
            await this.indexerDb.createOrderEdit(order);
        }

        // Store the SOURCE, GIVE_TICK, and GET_TICK in addresses list
        if(format==0){
            this.util.addAddressTicker(data['SOURCE'], [data['GIVE_TICK'], data['GET_TICK']]);
        } else {
            this.util.addAddressTicker(orderInfo['SOURCE'], orderInfo['GIVE_TICK'], orderInfo['GET_TICK']);
        }

        // If this was a valid transaction, add GIVE_AMOUNT to escrow
        if(status=='valid'){

            // Array of credits, debits, and escrows
            let credits = [],
                debits  = [],
                escrows = [];

            // If we are charging a fee, store the SOURCE and fees TICK in addresses list
            if(fees['AMOUNT']>0)
                this.util.addAddressTicker(data['SOURCE'], fees['TICK']);

            // Format 0 - Create Order
            if(format==0){
                // Debit GIVE_AMOUNT of GIVE_TICK from SOURCE
                debits.push([data['GIVE_TICK'], data['GIVE_AMOUNT'], data['SOURCE']]);

                // Escrow GIVE_AMOUNT of GIVE_TICK from SOURCE
                escrows.push([data['GIVE_TICK'], data['GIVE_AMOUNT'], data['SOURCE']]);

                // Create record in the orders_statuses table
                await this.indexerDb.createOrderStatus(data['ACTION_INDEX'], data['ACTION_INDEX'], 'open');
            }

            // Format 1 - Cancel Order
            // TODO: Update code to only credit back what remains escrowed, not entire amount (will cause sanity error in current format)
            if(format==1){
                // Debit GIVE_AMOUNT of GIVE_TICK from escrow
                // TODO: DO NOT remove escrow record... instead debit remaining amount from escrows instead (delete `removeEscrowRecord()` function entirely)
                await this.indexerDb.removeEscrowRecord(orderInfo['ACTION_INDEX']);

                // Credit GIVE_AMOUNT of GIVE_TICK to SOURCE
                credits.push([orderInfo['GIVE_TICK'], orderInfo['GIVE_AMOUNT'], orderInfo['SOURCE']]);

                // Create record in the orders_statuses table
                await this.indexerDb.createOrderStatus(data['ACTION_INDEX'], orderInfo['ACTION_INDEX'], 'cancelled');
            }

            // Handle any transaction FEE according the users's ADDRESS preferences
            [credits, debits] = await this.util.processTransactionFees(this.indexerDb, credits, debits, fees);

            // Process any transaction ledger changes (credits / debits / escrows)
            await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits, escrows);

            // Get a list of tickers & addresses
            let tickers   = this.util.getTickersList(),
                addresses = Object.keys(this.util.getAddressesList());

            // Update address balances and token supply
            await this.indexerDb.updateBalances(addresses);
            await this.indexerDb.updateTokens(tickers);

        }

        // Create action mappings
        await this.mapper.createMappings(data);

        // Reset the address/tickers/transactions list on each parse
        this.util.resetLists();

        /*****************************************************************
         * ORDER Matching Validations
         ****************************************************************/
        // TODO : move this to actions/order_match.js
        if(status=='valid'){

            // Get a list of any matching open orders
            let matches = await this.indexerDb.getOrderMatches(data);
            console.log('matches=',matches);
            if(matches){
                // Get information on the tokens involved in the order
                let getTokenInfo  = await this.indexerDb.getTokenInfo(data['GET_TICK'],  data['BLOCK_INDEX'], data['ACTION_INDEX']);
                let giveTokenInfo = await this.indexerDb.getTokenInfo(data['GIVE_TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX']);

                // List of addresses allowed or blocked from holding GET_TICK
                let getTokenAllowList = (getTokenInfo['ALLOW_LIST']) ? await this.indexerDb.getList(getTokenInfo['ALLOW_LIST']) : false;
                let getTokenBlockList = [getTokenInfo['BLOCK_LIST']] ? await this.indexerDb.getList(getTokenInfo['BLOCK_LIST']) : false;

                // List of addresses allowed or blocked from holding GIVE_TICK
                let giveTokenAllowList = (giveTokenInfo['ALLOW_LIST']) ? await this.indexerDb.getList(giveTokenInfo['ALLOW_LIST']) : false;
                let giveTokenBlockList = [giveTokenInfo['BLOCK_LIST']] ? await this.indexerDb.getList(giveTokenInfo['BLOCK_LIST']) : false;

                // List of addresses allowed or blocked from matching with this ORDER
                let orderInfoAllowList = (orderInfo['ALLOW_LIST']) ? await this.indexerDb.getList(orderInfo['ALLOW_LIST']) : false;
                let orderInfoBlockList = [orderInfo['BLOCK_LIST']] ? await this.indexerDb.getList(orderInfo['BLOCK_LIST']) : false;

                // Loop through matches and determine if we have a valid match
                let match = false;
                for(let order of matches){
                    let valid = true;

                       // List of addresses allowed or blocked from matching with this matching SWAP
                       let matchInfoAllowList = (order['ALLOW_LIST']) ? await this.indexerDb.getList(order['ALLOW_LIST']) : false;
                       let matchInfoBlockList = [order['BLOCK_LIST']] ? await this.indexerDb.getList(order['BLOCK_LIST']) : false;

                    // Check if GET_ADDRESS for both sides of order are allowed (ALLOW/BLOCK list support)
                    if( (getTokenAllowList.length  && (!getTokenAllowList.includes(data['GET_ADDRESS'])   || !getTokenAllowList.includes(order['GET_ADDRESS'])))  ||
                        (getTokenBlockList.length  && ( getTokenBlockList.includes(data['GET_ADDRESS'])   ||  getTokenBlockList.includes(order['GET_ADDRESS'])))  ||
                        (giveTokenAllowList.length && (!giveTokenAllowList.includes(data['GET_ADDRESS'])  || !giveTokenAllowList.includes(order['GET_ADDRESS']))) ||
                        (giveTokenBlockList.length && ( giveTokenBlockList.includes(data['GET_ADDRESS'])  ||  giveTokenBlockList.includes(order['GET_ADDRESS'])))  ||
                        (orderInfoAllowList.length && !orderInfoAllowList.includes(order['GET_ADDRESS'])) ||
                        (orderInfoBlockList.length &&  orderInfoBlockList.includes(order['GET_ADDRESS'])) || 
                        (matchInfoAllowList.length && !matchInfoAllowList.includes(data['GET_ADDRESS']))  ||
                        (matchInfoBlockList.length &&  matchInfoBlockList.includes(data['GET_ADDRESS']))){
                        valid = false;
                    }

                    // If we found a valid match, process the order match and update the escrowed amounts
                    // TODO : Revisit this code once multi-chain order support is added to xchain-hub component
                    if(valid){

                        // TODO: verify that both orders still have GIVE_AMOUNT and GET_AMOUNT greater than 0
                        // Get initial Escrowed balance using ORDER, then deduct any ORDER_MATCH balances

                        // Pass forward information on this order match
                        match = order;

                        // Reset credits, debits, and escrow arrays
                        credits = [],
                        debits  = [],
                        escrows = [];

                        // Define ORDER_MATCH action
                        let action = {}
                        action['BLOCK_INDEX'] = data['BLOCK_INDEX'];
                        action['TX_INDEX']    = data['TX_INDEX']
                        action['ACTION']      = 'ORDER_MATCH';

                        // Create a record of this ORDER_MATCH action in the actions table
                        data['ACTION_INDEX'] = await this.indexerDb.createActionIndex(action);

                        // Store the SOURCE and GET_TICK in addresses list
                        this.util.addAddressTicker(match['SOURCE'], match['GET_TICK']);

                        // Credit tokens to GET_ADDRESS in orders
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

                        // Create record of match in order_matches table
                        await this.indexerDb.createOrderMatch(data['ACTION_INDEX'], order, match, 'valid');

                        // TODO verify if order still has some GET_TICK and GIVE_TICK quantity. if not, change status to filled
                        // Update record in orders table to change status (open->filled)
                        await this.indexerDb.createOrderStatus(data['ACTION_INDEX'], order['ACTION_INDEX'], 'filled');
                        await this.indexerDb.createOrderStatus(data['ACTION_INDEX'], match['ACTION_INDEX'], 'filled');
                    }
                }

                // Get a list of addresses
                let addresses = Object.keys(this.util.getAddressesList());

                // Update address balances
                await this.indexerDb.updateBalances(addresses);

                // Create action mappings
                await this.mapper.createMappings(data);

            }
        }
    }
}

module.exports = Order;