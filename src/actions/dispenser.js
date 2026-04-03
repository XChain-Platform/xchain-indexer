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
 * XChain Platform Action - DISPENSER
 * 
 * This action creates a dispenser (vending machine) to dispense `TICK` when triggered
 * 
 * PARAMS:
 * VERSION                - Format Version                                                             
 * GIVE_COIN              - `COIN` name (BTC, LTC, DOGE, etc)                                          
 * GIVE_TICK              - Ticker name or Ticker ID                                                   
 * GIVE_AMOUNT            - Quantity of `GIVE_TICK` to `DISPENSE` when triggered                       
 * GIVE_ESCROW            - Quantity of `GIVE_TICK` to escrow in dispenser                             
 * GET_COIN               - `COIN` name (BTC, LTC, DOGE, etc)                                          
 * GET_TICK               - Ticker name or Ticker ID                                                   
 * GET_AMOUNT             - Quantity of `GET_COIN` or `GET_TICK` required to `DISPENSE`                
 * ADDRESS                - Address for dispenser to operate on (default=`SOURCE`)                     
 * FIAT_CODE              - Code for `FIAT` currency your dispenser is priced in (USD, JPY, GPB, etc.) 
 * FIAT_AMOUNT            - Amount of `FIAT` currency required to trigger a `DISPENSE`                 
 * EXPIRATION             - Timestamp of when dispenser should close, in Unix time                     
 * ALLOW_LIST             - `ACTION_INDEX` of a `LIST` of addresses allowed to trigger dispenser       
 * BLOCK_LIST             - `ACTION_INDEX` of a `LIST` of addresses NOT allowed to trigger a dispenser 
 * MEMO                   - An optional memo to include                                                
 * DISPENSER_ACTION_INDEX - `ACTION_INDEX` of existing `DISPENSER`                                     
 * 
 * FORMATS:
 * - 0 = Create Dispenser
 * - 1 = Cancel Dispenser
 * - 2 = Edit Dispenser
 *
 ********************************************************************/

class Dispenser {

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
        this.formats[0] = 'VERSION|GIVE_COIN|GIVE_TICK|GIVE_AMOUNT|GIVE_ESCROW|GET_COIN|GET_TICK|GET_AMOUNT|GET_ADDRESS|FIAT_CODE|FIAT_AMOUNT|EXPIRATION|ALLOW_LIST|BLOCK_LIST|MEMO';
        this.formats[1] = 'VERSION|DISPENSER_ACTION_INDEX|MEMO';
        this.formats[2] = 'VERSION|DISPENSER_ACTION_INDEX|GIVE_ESCROW|EXPIRATION|ALLOW_LIST|BLOCK_LIST|MEMO';

        // Define array of supported list types (1=Tick, 2=Address)
        this.listTypes = [2];
    }

    // Handle parsing the DISPENSER transaction
    async parse(params, data, error){
        /*****************************************************************
         * DEBUGGING - Force params
         ****************************************************************/
        // let str    = "0|BTC|JDOG|1|10|BTC||0.01|1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev||||||Creating JDOG dispensers at 0.01 BTC each";
        // let str    = "1|1234|Closing JDOG Dispenser";
        // let str    = "2|1234|100||||Refilling with 100";
        // let str    = "2|1234|||9876|5432|Updating allow/block lists";
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

        // Get information on a dispenser given the COIN network and DISPENSER_ACTION_INDEX
        var dispenserInfo = false;
        if(format==1 || format==2)
            dispenserInfo = await this.indexerDb.getDispenserInfo(this.config['COIN'], data['DISPENSER_ACTION_INDEX'], data['BLOCK_TIME']);

        // Get information on the GIVE and GET tokens
        let info = (format==0) ? data : dispenserInfo;
        let giveTokenInfo = await this.indexerDb.getTokenInfo(info['GIVE_TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX']);
        let getTokenInfo  = false;

        // Get the GET token info if this is the correct COIN network
        if(info['GET_COIN'] == this.config['COIN'] && !this.util.isNull(info['GET_TICK']))
            getTokenInfo = await this.indexerDb.getTokenInfo(info['GET_TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX']);

        // Get source address balances and preferences
        let balances    = await this.indexerDb.getAddressBalances(data['SOURCE'], null, data['BLOCK_INDEX'], data['ACTION_INDEX']);
        let preferences = await this.indexerDb.getAddressPreferences(data['SOURCE'], data['BLOCK_INDEX'], data['ACTION_INDEX']);

        // Create the fees object 
        let fees = await this.util.createFeesObject(this.indexerDb, data, preferences);

        // Default GET_ADDRESS to SOURCE address if COIN networks are the same and GET_ADDRESS is not given
        if(this.config['COIN']==data['GET_COIN'] && this.util.isNull(data['GET_ADDRESS']))
            data['GET_ADDRESS'] = data['SOURCE'];

        // Set default EXPIRATION value if none is given
        if(format==0 && this.util.isNull(data['EXPIRATION']))
            data['EXPIRATION'] = this.util.getDefaultExpiration(data['BLOCK_TIME']);

        // Clone the raw data for storage in dispensers table
        let dispenser = Object.assign({}, data);

        /*****************************************************************
         * TICK / COIN / FIAT Validations
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
        // TODO: Remove this and allow support for cross-chain dispensers once xchain-hub is finished and working properly
        if(!error && format==0 && this.config['COIN']!=data['GET_COIN'])
            error = "invalid: GET_COIN (network)";

        // Validate GIVE_TICK exists
        if(!error && format==0 && !giveTokenInfo)
            error = 'invalid: GIVE_TICK (unknown)';

        // Validate GET_TICK exists
        if(!error && format==0 && !this.util.isNull(data['GET_TICK']) && !getTokenInfo)
            error = 'invalid: GET_TICK (unknown)';

        // Validate FIAT_CODE is valid
        if(!error && format==0 && !this.util.isNull(data['FIAT_CODE']) && this.util.isNull(this.config['FIATS'][data['FIAT_CODE']]))
            error = 'invalid: FIAT_CODE (unsupported FIAT)';

        /*****************************************************************
         * FORMAT Validations
         ****************************************************************/

        // Verify GIVE_AMOUNT format
        if(!error && format==0 && !this.util.isNull(data['GIVE_AMOUNT']) && !this.util.isValidAmountFormat(giveTokenInfo['DECIMALS'], data['GIVE_AMOUNT']))
            error = "invalid: GIVE_AMOUNT (format)";

        // Verify GIVE_ESCROW format
        if(!error && format==0 && !this.util.isNull(data['GIVE_ESCROW']) && !this.util.isValidAmountFormat(giveTokenInfo['DECIMALS'], data['GIVE_ESCROW']))
            error = "invalid: GIVE_ESCROW (format)";

        // Verify GET_AMOUNT format
        if(!error && format==0 && !this.util.isNull(data['GET_AMOUNT']) && getTokenInfo && !this.util.isValidAmountFormat(getTokenInfo['DECIMALS'], data['GET_AMOUNT']))
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

        // Validate that FIAT_AMOUNT is in 0.00 format
        if(!error && format==0 && !this.util.isNull(data['FIAT_CODE']) && !this.util.isNull(data['FIAT_AMOUNT']) && !this.util.isValidFiatFormat(2, data['FIAT_AMOUNT']))
            error = 'invalid: FIAT_AMOUNT (format)';


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

        // Verify TICK action is allowed from GET_ADDRESS (allow/block lists)
        if(!error && format==0 && await this.indexerDb.isActionAllowed(data['GET_ADDRESS'], data['GIVE_TICK']) == false)
            error = 'invalid: GET_ADDRESS (not authorized)';

        // Validate DISPENSER_ACTION_INDEX is valid dispenser
        if(!error && (format==1 || format==2) && !dispenserInfo)
            error = 'invalid: DISPENSER_ACTION_INDEX (unknown)';

        // Verify SOURCE address is owner of the DISPENSER_ACTION_INDEX dispenser
        if(!error && format!=0 && data['SOURCE']!=dispenserInfo['SOURCE'] && data['SOURCE']!=dispenserInfo['GET_ADDRESS'])
            error = 'invalid: SOURCE (not owner)';

        // Validate DISPENSER_ACTION_INDEX is valid dispenser with a status of open
        if(!error && format!=0 && dispenserInfo['DISPENSER_STATUS']!='open')
            error = 'invalid: DISPENSER_ACTION_INDEX (dispenser not open)';

        // Validate that EXPIRATION is greater than current BLOCK_TIME
        if(!error && !this.util.isNull(data['EXPIRATION']) && this.util.bclte(data['EXPIRATION'], data['BLOCK_TIME']))
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

        // Verify SOURCE has enough balances to cover GIVE_ESCROW
        if(!error && !this.util.isNull(data['GIVE_ESCROW']) && !this.util.hasBalance(balances, giveTokenInfo['TICK_ID'], data['GIVE_ESCROW']))
            error = 'invalid: insufficient funds (GIVE_ESCROW)';

        // Adjust balances to reduce by dispenser GIVE_ESCROW
        if(!error && !this.util.isNull(data['GIVE_ESCROW']))
            balances = this.util.debitBalances(balances, giveTokenInfo['TICK_ID'], data['GIVE_ESCROW']);

        // Calculate total fee for this dispenser based on EXPIRATION timestamp
        fees['AMOUNT'] = 0;

        // Calculate the fee to charge based on the EXPIRATION
        if(!error && !this.util.isNull(data['EXPIRATION'])){
            let unifiedFees = await this.actions.protocolChanges.isEnabled('UNIFIED_FEES', data['BLOCK_INDEX']);
            if(unifiedFees){
                let result = this.util.getUnifiedExpirationFee(data, dispenserInfo);
                fees['GAS_COST']    = result.gasCost;
                fees['AMOUNT']      = result.fee;
                fees['FEE_VERSION'] = 2;
            } else {
                fees['AMOUNT'] = this.util.getExpirationFee(data, dispenserInfo);
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
        data['STATUS'] = dispenser['STATUS'] = status;

        // Set DISPENSER status to 'open' when creating a valid dispenser
        dispenser['DISPENSER_STATUS'] = (status=='valid') ? 'open' : 'invalid';

        // Print status message
        if(format==0)
            console.log("\t DISPENSER : " + data['GIVE_AMOUNT'] + ' ' + this.config['COIN'] + ':' + data['GIVE_TICK'] + ' = '  +  data['GET_AMOUNT'] + ' ' + data['GET_COIN'] + ':' + data['GET_TICK'] + ' : ' + data['STATUS']);
        if(format==1)
            console.log("\t DISPENSER_CANCEL : " + this.config['COIN'] + ':' + data['DISPENSER_ACTION_INDEX'] + ' : ' + data['STATUS']);
        if(format==2)
            console.log("\t DISPENSER_EDIT : " + this.config['COIN'] + ':' + data['DISPENSER_ACTION_INDEX'] + ' : ' + data['STATUS']);
 
        // Create record in dispensers table
        if(format==0)
            await this.indexerDb.createDispenser(dispenser);

        // Update action from DISPENSER to DISPENSER_CANCEL and create record in dispenser_cancels table
        if(format==1){
            await this.indexerDb.updateActionIndex(data['ACTION_INDEX'], 'DISPENSER_CANCEL');
            await this.indexerDb.createDispenserCancel(dispenser);
        }

        // Update action from DISPENSER to DISPENSER_EDIT and create record in dispenser_edits table
        if(format==2){
            await this.indexerDb.updateActionIndex(data['ACTION_INDEX'], 'DISPENSER_EDIT');
            await this.indexerDb.createDispenserEdit(dispenser);
        }

        // Store the SOURCE, GIVE_TICK, and GET_TICK in addresses list
        if(format==0){
            this.util.addAddressTicker(data['SOURCE'], [data['GIVE_TICK'], data['GET_TICK']]);
            this.util.addAddressTicker(data['GET_ADDRESS'], [data['GIVE_TICK'], data['GET_TICK']]);
        } else {
            this.util.addAddressTicker(dispenserInfo['SOURCE'], [dispenserInfo['GIVE_TICK'], dispenserInfo['GET_TICK']]);
            this.util.addAddressTicker(dispenserInfo['GET_ADDRESS'], [dispenserInfo['GIVE_TICK'], dispenserInfo['GET_TICK']]);
        }

        // Array of credits, debits, and escrows
        let credits = [],
            debits  = [],
            escrows = [];

        // If this was a valid transaction, add GIVE_AMOUNT to escrow
        if(status=='valid'){

            // If we are charging a fee, store the SOURCE and fees TICK in addresses list
            if(this.util.bcgt(fees['AMOUNT'], 0))
                this.util.addAddressTicker(data['SOURCE'], fees['TICK']);

            // Debit GIVE_ESCROW GIVE_TICK from SOURCE and add to escrow
            if((format==0||format==2) && !this.util.isNull(data['GIVE_ESCROW'])){
                debits.push([giveTokenInfo['TICK'], data['GIVE_ESCROW'], data['SOURCE']]);
                escrows.push([giveTokenInfo['TICK'], data['GIVE_ESCROW'], data['SOURCE']]);
            }

            // Format 0 - Create Dispenser
            if(format==0)
                await this.indexerDb.createDispenserStatus(data['ACTION_INDEX'], data['ACTION_INDEX'], 'open');

            // Format 1 - Cancel Dispenser
            // Note: Dispenser remains open for a set amount of time (DISPENSER_CLOSE_DELAY) before being closed
            if(format==1)
                await this.indexerDb.createDispenserStatus(data['ACTION_INDEX'], dispenserInfo['ACTION_INDEX'], 'cancelling');

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
    }
}

module.exports = Dispenser;