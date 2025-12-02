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
 * XChain Platform Action - SEND
 * 
 * This action sends one or more `TICK` to an `ADDRESS`.
 * 
 * PARAMS:
 * - VERSION     - Format Version        
 * - TICK        - Ticker name or Ticker ID
 * - AMOUNT      - Amount of `tokens` to send      
 * - DESTINATION - Address to transfer `tokens` to 
 * - MEMO        - An optional memo to include     
 * 
 * FORMATS:
 * - 0 = Single Send
 * - 1 = Multi-Send (Brief)
 * - 2 = Multi-Send (Full)
 * - 3 = Multi-Send (Full) with Multiple Memos
 * 
 ********************************************************************/

class Send {

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
        this.formats[0] = 'VERSION|TICK|AMOUNT|DESTINATION|MEMO';
        this.formats[1] = 'VERSION|TICK|AMOUNT|DESTINATION|AMOUNT|DESTINATION|MEMO';
        this.formats[2] = 'VERSION|TICK|AMOUNT|DESTINATION|TICK|AMOUNT|DESTINATION|MEMO';
        this.formats[3] = 'VERSION|TICK|AMOUNT|DESTINATION|MEMO|TICK|AMOUNT|DESTINATION|MEMO';
    }

    // Handle parsing the SEND transaction
    async parse(params, data, error){
        /*****************************************************************
         * DEBUGGING - Force params
         ****************************************************************/
        // let str = '0|JDOG|1|1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev';
        // let str = '0|JDOG|1|1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev|Testing Memos';
        // let str = '1|BRRR|5|1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev|1|1BoogrfDADPLQpq8LMASmWQUVYDp4t2hF9';
        // let str = '1|BRRR|5|1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev|1|1BoogrfDADPLQpq8LMASmWQUVYDp4t2hF9|Testing Memos2';
        // let str = '1|BRRR|5|1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev|1|1BoogrfDADPLQpq8LMASmWQUVYDp4t2hF9|3|1BTNSGASK5En7rFurDJ79LQ8CVYo2ecLC8';
        // let str = '1|BRRR|5|1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev|1|1BoogrfDADPLQpq8LMASmWQUVYDp4t2hF9|3|1BTNSGASK5En7rFurDJ79LQ8CVYo2ecLC8|Testing Memos3';
        // let str = '2|BRRR|5|1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev|TEST|1|1BoogrfDADPLQpq8LMASmWQUVYDp4t2hF9';
        // let str = '2|BRRR|5|1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev|TEST|1|1BoogrfDADPLQpq8LMASmWQUVYDp4t2hF9|Testing Memos4';
        // let str = '2|BRRR|5|1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev|TEST|1|1BoogrfDADPLQpq8LMASmWQUVYDp4t2hF9|BACON|3|1BTNSGASK5En7rFurDJ79LQ8CVYo2ecLC8';
        // let str = '2|BRRR|5|1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev|TEST|1|1BoogrfDADPLQpq8LMASmWQUVYDp4t2hF9|BACON|3|1BTNSGASK5En7rFurDJ79LQ8CVYo2ecLC8|Testing Memos5';
        // let str = '3|BRRR|5|1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev|Testing Memos1|BRRR|5|1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev|Testing Memos11|TEST|1|1BoogrfDADPLQpq8LMASmWQUVYDp4t2hF9|Testing Memos2|BACON|3|1BTNSGASK5En7rFurDJ79LQ8CVYo2ecLC8|Testing Memos3';
        // params = String(str).split('|');
        // data['FORMAT'] = this.util.getFormatVersion(params[0]);

        // Validate that format is known
        let format = data['FORMAT'];
        if(!error && (format===null || this.formats[format] === undefined ))
            error = 'invalid: VERSION (unknown)';

        // Array of sends [TICK, AMOUNT, DESTINATION, MEMO]
        let sends = []; 

        // Extract memo
        let memo = null;
        let last = params.length - 1;
        for(let idx in params)
            if(idx==last && ((format==0 && idx==4) || (format==1 && idx%2==0) || (format==2 && idx%3==1)))
                memo = params[idx];

        // If we encountered an invalid version error add it to the sends list so we create a record of it in sends
        if(error)
            sends.push([params[0], params[1], memo]);

        // Build out array of sends
        let lastIdx = params.length - 1;        
        for(let idx in params){
            // Force index to integer value
            idx = parseInt(idx);

            // Single Send
            if(format==0 && idx==0)
                sends.push([params[1], params[2], params[3], memo]);

            // Multi-Send (Brief)
            if(format==1 && idx>1 && idx%2==1)
                sends.push([params[1], params[idx-1], params[idx], memo]);

            // Multi-Send (Full)
            if(format==2 && idx>0 && idx%3==1 && idx < lastIdx)
                sends.push([params[idx], params[(idx+1)], params[idx+2], memo]);

            // Multi-Send (Full) with Multiple Memos
            if(format==3 && idx>0 && idx%4==1 && idx < lastIdx)
                sends.push([params[idx], params[idx+1], params[idx+2], params[idx+3]]);
        }

        // Get token data for every TICK (reduces duplicated sql queries)
        let ticks = {};
        for(let send of sends){
            let tick = send[0];
            if(!ticks[tick])
                ticks[tick] = await this.indexerDb.getTokenInfo(tick, data['BLOCK_INDEX'], data['ACTION_INDEX']);
        }

        // Consolidate sends by DESTINATION and TICK
        let keys = {};
        for(let info of sends){
            let [tick, amount, destination, memo] = info;
            let key = destination + '|' + tick;
            if(!this.util.isNull(keys[key]))
                amount = this.util.bcadd(amount, keys[key][1], ticks[tick]['DECIMALS']);
            keys[key] = [tick, amount, destination, memo];
        }

        // Update sends using consolidated info
        sends = [];
        for(let key in keys)
            sends.push(keys[key]);

        // Get source address balances
        let balances = await this.indexerDb.getAddressBalances(data['SOURCE'], null, data['BLOCK_INDEX'], data['ACTION_INDEX']);

        // Store original error value
        let origError = error;

        // Array of credits and debits
        let credits = [],
            debits  = [];

        // Loop through sends and process each
        for(let idx in sends){

            // Parse in the send information
            let info = sends[idx];

            // Reset error to the original value
            error = origError;

            // Copy base transaction data object
            let send = data;

            // Update transaction data object with send values
            send['TICK']        = info[0];
            send['AMOUNT']      = info[1];
            send['DESTINATION'] = info[2];
            send['MEMO']        = info[3];

            // Convert NUMBER fields from string value to number value so comparisons are mathematical 
            if(!error)
                send = this.util.setNumberFormats(send);

            // Get information on token
            let tokenInfo = ticks[send['TICK']];

            /*****************************************************************
             * TICK Validations
             ****************************************************************/

            // Validate TICK exists
            if(!error && !tokenInfo)
                error = 'invalid: TICK (unknown)';

            /*************************************************************
             * FORMAT Validations
             ************************************************************/

            // Verify AMOUNT format
            if(!error && !this.util.isNull(send['AMOUNT']) && !this.util.isValidAmountFormat(tokenInfo['DECIMALS'], send['AMOUNT']))
                error = "invalid: AMOUNT (format)";

            // Verify DESTINATION address format
            if(!error && !this.util.isNull(send['DESTINATION']) && !this.util.isCryptoAddress(send['DESTINATION']))
                error = "invalid: DESTINATION (format)";

            /*************************************************************
             * General Validations
             ************************************************************/

            // Verify SOURCE is allowed to perform action
            if(!error && !await this.indexerDb.isActionAllowed(send['SOURCE'], null, send['BLOCK_INDEX']))
                error = 'invalid: SOURCE (sleeping)';

            // Verify TICK is allowed to perform action
            if(!error && !await this.indexerDb.isActionAllowed(null, send['TICK'], send['BLOCK_INDEX']))
                error = 'invalid: TICK (sleeping)';

            // Verify TICK action is allowed from SOURCE (allow/block lists)
            if(!error && !this.indexerDb.isActionAllowed(send['SOURCE'], send['TICK']))
                error = 'invalid: SOURCE (not authorized)';

            // Verify TICK action is allowed to DESTINATION (allow/block lists)
            if(!error && !this.indexerDb.isActionAllowed(send['DESTINATION'], send['TICK']))
                error = 'invalid: DESTINATION (not authorized)';

            // Verify no pipe in MEMO (pipe is field delimiter)
            if(!error && String(send['MEMO']).indexOf('|')!=-1)
                error = 'invalid: MEMO (pipe)';

            // Verify no semicolon in MEMO (semicolon is action delimiter)
            if(!error && String(send['MEMO']).indexOf(';')!=-1)
                error = 'invalid: MEMO (semicolon)';

            // Verify MEMO is shorter than MAX_MEMO_LENGTH
            if(!error && String(send['MEMO']).length > this.config['MAX_MEMO_LENGTH'])
                error = 'invalid: MEMO (length)';

            // Verify SOURCE has enough balances to cover send AMOUNT
            if(!error && !this.util.hasBalance(balances, tokenInfo['TICK_ID'], send['AMOUNT']))
                error = 'invalid: insufficient funds';
        
            // Adjust balances to reduce by SEND AMOUNT
            if(!error)
                balances = this.util.debitBalances(balances, tokenInfo['TICK_ID'], send['AMOUNT']);

            // Determine final status
            let status = (error) ? error : 'valid';
            data['STATUS'] = send['STATUS'] = status;
    
            // Print status message 
            console.log("\t SEND : " + send['TICK'] + ' : ' + send['AMOUNT'] + ' : ' + send['DESTINATION'] + ' : '+ data['STATUS']);
    
            // Create record in sends table
            await this.indexerDb.createSend(send);
    
            // Store the SOURCE and TICK in addresses list
            this.util.addAddressTicker(data['SOURCE'], send['TICK']);

            // If this was a valid transaction, then add records to the credits and debits array
            if(status=='valid'){

                // Store the DESTINATION and TICK in addresses list
                this.util.addAddressTicker(send['DESTINATION'], send['TICK']);

                // Add ticker and amount to debits array
                debits.push([send['TICK'], send['AMOUNT'], send['SOURCE']]);

                // Add ticker, amount, and destination to credits array
                credits.push([send['TICK'], send['AMOUNT'], send['DESTINATION']]);
            }
        }

        // Process any transaction ledger changes (credits / debits)
        await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits);

        // Get a list of tickers & addresses
        let addresses = Object.keys(this.util.getAddressesList());

        // Update address balances
        await this.indexerDb.updateBalances(addresses);

        // Create action mappings
        await this.mapper.createMappings(data);

        // Check if any sends triggered dispensers
        await this.util.processDispenserSends(this.actions, this.indexerDb, data);

    }
}

module.exports = Send;