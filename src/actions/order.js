/*********************************************************************
 * 
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 * 
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided “AS IS”, without warranties or conditions of any kind.
 * 
 **********************************************************************
 *
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

        // Define array of supported list types (1=Tick, 2=Address)
        this.listTypes = [2];
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
        // data['FORMAT'] = this.util.getFormatVersion(params[0]);

        // Validate that format is known
        let format = data['FORMAT'];
        if(!error && (format===null || this.formats[format] === undefined ))
            error = 'invalid: VERSION (unknown)';

        // Parse PARAMS using given VERSION format and update transaction data object
        if(!error)
            data = this.util.setActionParams(data, params, this.formats, format);

        // Convert NUMBER fields from string value to number value so comparisons are mathematical 
        if(!error)
            data = this.util.setNumberFormats(data);

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
        let fees = await this.util.createFeesObject(this.indexerDb, data, preferences);

        // Default GET_ADDRESS to SOURCE address if COIN networks are the same and GET_ADDRESS is not given
        if(this.config['COIN']==data['GET_COIN'] && this.util.isNull(data['GET_ADDRESS']))
            data['GET_ADDRESS'] = data['SOURCE'];

        // Set EXPIRATION value if none is given
        if(format==0 && this.util.isNull(data['EXPIRATION']))
            data['EXPIRATION'] = this.util.getDefaultExpiration(data['BLOCK_TIME']);

        // Clone the raw data for storage in orders table
        let order = Object.assign({}, data);

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

        // validate GET_COIN network is current COIN network
        // TODO: Remove this and allow support for cross-chain orders once xchain-hub is finished and working properly
        if(!error && format==0 && this.config['COIN']!=data['GET_COIN'])
            error = "invalid: GET_COIN (network)";

        // Validate GIVE_TICK exists
        if(!error && format==0 && !giveTokenInfo)
            error = 'invalid: GIVE_TICK (unknown)';

        // Validate GET_TICK exists
        if(!error && format==0 && !getTokenInfo)
            error = 'invalid: GET_TICK (unknown)';

        /*****************************************************************
         * FORMAT Validations
         ****************************************************************/

        // Verify GIVE_AMOUNT format
        if(!error && format==0 && !this.util.isNull(data['GIVE_AMOUNT']) && !this.util.isValidAmountFormat(giveTokenInfo['DECIMALS'], data['GIVE_AMOUNT']))
            error = "invalid: GIVE_AMOUNT (format)";

        // Verify GET_AMOUNT format
        if(!error && format==0 && !this.util.isNull(data['GET_AMOUNT']) && !this.util.isValidAmountFormat(getTokenInfo['DECIMALS'], data['GET_AMOUNT']))
            error = "invalid: GET_AMOUNT (format)";

        // Verify GET_ADDRESS is given if COIN network differs from GET_COIN network
        if(!error && format==0 && this.config['COIN']!=data['GET_COIN'] && this.util.isNull(data['GET_ADDRESS']))
            error = "invalid: GET_ADDRESS";

        // Verify GET_ADDRESS is valid for the given GET_COIN network
        if(!error && format==0 && !this.util.isNull(data['GET_ADDRESS']) && !this.util.isCryptoAddress(data['GET_ADDRESS']))
            error = "invalid: GET_ADDRESS (format)";

        // Validate that EXPIRATION is an integer
        if(!error && !this.util.isNull(data['EXPIRATION']) && (!this.util.isNumeric(data['EXPIRATION']) || !this.util.isInteger(data['EXPIRATION'])))
            error = "invalid: EXPIRATION (format)";

        /*****************************************************************
         * General Validations
         ****************************************************************/

        // Verify SOURCE is not sleeping
        if(!error && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
            error = 'invalid: SOURCE (sleeping)';

        // Verify TICK is not sleeping
        if(!error && format==0 && await this.indexerDb.isActionAllowed(null, data['GIVE_TICK'], data['BLOCK_INDEX']) == false)
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
        if(!error && format==0 && await this.indexerDb.isActionAllowed(data['SOURCE'], data['GIVE_TICK']) == false)
            error = 'invalid: SOURCE (not authorized)';

        // Validate ORDER_ACTION_INDEX is valid SWAP
        if(!error && (format==1 || format==2) && !orderInfo)
            error = 'invalid: ORDER_ACTION_INDEX (unknown)';

        // Verify SOURCE address is owner of the ORDER_ACTION_INDEX order
        if(!error && (format==1 || format==2) && data['SOURCE']!=orderInfo['SOURCE'])
            error = 'invalid: SOURCE (not owner)';

        // Validate ORDER_ACTION_INDEX is valid ORDER with a status of open
        if(!error && (format==1 || format==2) && orderInfo['ORDER_STATUS']!='open')
            error = 'invalid: ORDER_ACTION_INDEX (order not open)';

        // Validate that EXPIRATION is greater than current BLOCK_TIME
        if(!error && !this.util.isNull(data['EXPIRATION']) && data['EXPIRATION'] <= data['BLOCK_TIME'])
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
        if(!error && (format==0 || format==2) && !this.util.isNull(data['EXPIRATION']))
            fees['AMOUNT'] = this.util.getExpirationFee(data, orderInfo);

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
            console.log("\t ORDER_CANCEL : " + this.config['COIN'] + ':' + data['ORDER_ACTION_INDEX'] + ' : ' + data['STATUS']);
        if(format==2)
            console.log("\t ORDER_EDIT: " + this.config['COIN'] + ':' + data['ORDER_ACTION_INDEX'] + ' : ' + data['STATUS']);
 
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
        } else if(orderInfo) {
            this.util.addAddressTicker(orderInfo['SOURCE'], [orderInfo['GIVE_TICK'], orderInfo['GET_TICK']]);
        }

        // Array of credits, debits, and escrows
        let credits = [],
            debits  = [],
            escrows = [];

        // If this was a valid transaction, add GIVE_AMOUNT to escrow
        if(status=='valid'){

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
            if(format==1){

                // Debit token from escrows
                escrows.push([orderInfo['GIVE_TICK'], -orderInfo['GIVE_REMAINING'], orderInfo['SOURCE']]);

                // Credit token to SOURCE
                credits.push([orderInfo['GIVE_TICK'], orderInfo['GIVE_REMAINING'], orderInfo['SOURCE']]);

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

        // Check to see if we have any matches for this order
        if(status=='valid')
            await this.actions.processAction('ORDER_MATCH', null, data, null);
    }
}

module.exports = Order;