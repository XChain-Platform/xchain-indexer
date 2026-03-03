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
 * XChain Platform Action - SWEEP
 * 
 * This action transfers all `TICK` balances and/or ownerships to a `DESTINATION` address.
 * 
 * PARAMS:
 * - VERSION     - Format Version
 * - DESTINATION - address where `token` shall be swept
 * - BALANCES    - Indicates if address `token` balances should be swept (default=1)
 * - OWNERSHIPS  - Indicates if address `token` ownerships should be swept (default=1)
 * - ESCROWS     - Indicates if escrowed tokens should be swept (default=0)
 * - MEMO        - Optional memo to include
 * 
 * FORMATS:
 * - 0 = Full
 * 
 ********************************************************************/

class Sweep {

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
        this.formats[0] = 'VERSION|DESTINATION|BALANCES|OWNERSHIPS|ESCROWS|MEMO';
    }

    // Handle parsing the SWEEP transaction
    async parse(params, data, error){
        /*****************************************************************
         * DEBUGGING - Force params
         ****************************************************************/
        // let str = '0|1BoogrfDADPLQpq8LMASmWQUVYDp4t2hF9|1|1|1|memo';
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

        // Get source address balances, preferences, and token ownerships
        let balances    = await this.indexerDb.getAddressBalances(data['SOURCE'], null, data['BLOCK_INDEX'], data['ACTION_INDEX']);
        let preferences = await this.indexerDb.getAddressPreferences(data['SOURCE'], data['BLOCK_INDEX'], data['ACTION_INDEX']);
        let ownerships  = await this.indexerDb.getAddressOwnerships(data['SOURCE']);
        let escrowed    = await this.indexerDb.getAddressEscrows(data['SOURCE'], null, data['BLOCK_INDEX'], data['ACTION_INDEX']);

        // Create the fees object 
        let fees = await this.util.createFeesObject(this.indexerDb, data, preferences);

        /*****************************************************************
         * FORMAT Validations
         ****************************************************************/

        // Verify DESTINATION address format
        if(!error && !this.util.isNull(data['DESTINATION']) && !this.util.isCryptoAddress(data['DESTINATION']))
            error = "invalid: DESTINATION (format)";

        // Verify BALANCES format is valid (0 or 1)
        if(!error && !this.util.isNull(data['BALANCES']) && !this.util.isValidValue(data['BALANCES'],[0,1]))
            error = "invalid: BALANCES (format)";

        // Verify OWNERSHIPS format is valid (0 or 1)
        if(!error && !this.util.isNull(data['OWNERSHIPS']) && !this.util.isValidValue(data['OWNERSHIPS'],[0,1]))
            error = "invalid: OWNERSHIP (format)";

        // Verify ESCROWS format is valid (0 or 1)
        if(!error && !this.util.isNull(data['ESCROWS']) && !this.util.isValidValue(data['ESCROWS'],[0,1]))
            error = "invalid: ESCROWS (format)";

        // Set default values for BALANCES, OWNERSHIP, and ESCROWS
        data['BALANCES']   = (!this.util.isNull(data['BALANCES'])) ? data['BALANCES'] : 1;
        data['OWNERSHIPS'] = (!this.util.isNull(data['OWNERSHIPS'])) ? data['OWNERSHIPS'] : 1;
        data['ESCROWS']    = (!this.util.isNull(data['ESCROWS'])) ? data['ESCROWS'] : 0;

        // Clone the raw data for storage in mints table
        let sweep = Object.assign({}, data);

        /*****************************************************************
         * General Validations
         ****************************************************************/

        // Verify SOURCE is not sleeping
        if(!error && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
            error = 'invalid: SOURCE (sleeping)';

        // Verify no pipe in MEMO (pipe is field delimiter)
        if(!error && !this.util.isNull(data['MEMO']) && String(data['MEMO']).indexOf('|')!=-1)
            error = 'invalid: MEMO (pipe)';

        // Verify no semicolon in MEMO (semicolon is action delimiter)
        if(!error && !this.util.isNull(data['MEMO']) && String(data['MEMO']).indexOf(';')!=-1)
            error = 'invalid: MEMO (semicolon)';

        // Verify MEMO is shorter than MAX_MEMO_LENGTH
        if(!error && String(data['MEMO']).length > this.config['MAX_MEMO_LENGTH'])
            error = 'invalid: MEMO (length)';

        // TODO: Verify sweep is allowed to new address (ALLOW_LIST & BLOCK_LIST)
        // TODO: Verify sweep is allowed on each TICK (SLEEP)

        // Calculate total number of database hits for this SWEEP
        let db_hits = 1;                                                                               // 1 sweeps
            db_hits += (data['BALANCES']) ? this.util.bcmul(Object.keys(balances).length,4,0) : 0;     // 1 debits, 1 credits, 2 balances
            db_hits += (data['ESCROWS']) ? this.util.bcmul(Object.keys(escrowed).length,4,0) : 0;      // 1 escrows, 1 credits, 2 balances
            db_hits += (data['OWNERSHIPS']) ? this.util.bcmul(Object.keys(ownerships).length,2,0) : 0; // 1 issue, 1 tokens

        // Determine total transaction FEE based on database hits
        fees['AMOUNT'] = this.util.getTransactionFee(db_hits, fees['TICK']);

        // DEBUG
        // console.log('source=',data['SOURCE']);
        // console.log('balances=',balances);
        // console.log('ownerships=',ownerships);
        // console.log('preferences=',preferences);
        // console.log('db_hits=',db_hits);
        // console.log('fees=',fees);

        // Verify SOURCE has enough balances to cover FEE AMOUNT
        if(!error && !this.util.hasBalance(balances, fees['TICK_ID'], fees['AMOUNT']))
            error = 'invalid: insufficient funds (FEE)';

        // Adjust balances to reduce by FEE AMOUNT
        if(!error)
            balances = this.util.debitBalances(balances, fees['TICK_ID'], fees['AMOUNT']);

        // Determine final status
        let status = (error) ? error : 'valid';
        data['STATUS'] = sweep['STATUS'] = status;

        // Print status message 
        console.log("\t SWEEP : " + sweep['DESTINATION'] + ' : '+ sweep['STATUS']);

        // Create record in sweeps table
        await this.indexerDb.createSweep(sweep);

        // If this was a valid transaction, then mint any actual supply
        if(status=='valid'){

            // Array of credits and debits
            let credits = [],
                escrows = [],
                debits  = [];

            // If we are charging a fee, store the SOURCE and fees TICK in addresses list
            if(this.util.bcgt(fees['AMOUNT'], 0))
                this.util.addAddressTicker(data['SOURCE'], fees['TICK']);

            // Handle any transaction FEE according the users's ADDRESS preferences
            [credits, debits] = await this.util.processTransactionFees(this.indexerDb, credits, debits, fees);

            // Transfer escrowed tokens
            if(data['ESCROWS']==1){
                // Get list of actions with escrowed tokens
                for(let escrow of escrowed){

                    // Handle closing orders
                    if(escrow.type=='order'){
                        let info = await this.indexerDb.getOrderInfo(this.config['COIN'], escrow.action_index);
                        escrows.push([info['GIVE_TICK'], -info['GIVE_REMAINING'], info['SOURCE']]);
                        await this.indexerDb.createOrderStatus(data['ACTION_INDEX'], info['ACTION_INDEX'], 'cancelled');
                    }

                    // Handle closing swaps
                    if(escrow.type=='swap'){
                        let info = await this.indexerDb.getSwapInfo(this.config['COIN'], escrow.action_index);
                        escrows.push([info['GIVE_TICK'], -info['GIVE_AMOUNT'], info['SOURCE']]);
                        await this.indexerDb.createSwapStatus(data['ACTION_INDEX'], info['ACTION_INDEX'], 'cancelled');
                    }

                    // Handle canceling dispensers
                    // Note: Dispensers close after a set block delay, and escrowed tokens are credited to destination address
                    if(escrow.type=='dispenser')
                        await this.indexerDb.createDispenserStatus(data['ACTION_INDEX'], escrow.action_index, 'cancelling');

                }

                // Store the SOURCE and DESTINATION in the addresses list
                this.util.addAddressTicker(data['SOURCE']);
                this.util.addAddressTicker(data['DESTINATION']);
            }

            // Transfer any balances
            if(data['BALANCES']==1){
                for(let tick_id in balances){
                    let amount = balances[tick_id];
                    let tick   = await this.indexerDb.getTicker(tick_id);

                    // Debit token amount from SOURCE and credit to DESTINATION
                    debits.push([tick,  amount, data['SOURCE']]);
                    credits.push([tick, amount, data['DESTINATION']]);

                    // Store the SOURCE, DESTINATION and TICK in addresses and tickers lists
                    this.util.addAddressTicker(data['SOURCE'], tick);
                    this.util.addAddressTicker(data['DESTINATION'], tick);
                }
            }

            // Process any transaction ledger changes (credits / debits)
            await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits, escrows);

            // Get a list of tickers & addresses
            let tickers   = this.util.getTickersList(),
                addresses = Object.keys(this.util.getAddressesList());

            // Update address balances and token supply
            await this.indexerDb.updateBalances(addresses);
            await this.indexerDb.updateTokens(tickers);

            // Create action mappings for this sweep
            await this.mapper.createMappings(data);

            // Transfer token ownerships
            if(data['OWNERSHIPS']==1){
                for(let tick of ownerships){

                    // Reset the address/tickers/transactions list on each parse
                    this.util.resetLists();

                    // Copy base transaction data object into issue object
                    let issue = sweep;
                    issue['ACTION']   = 'ISSUE';
                    issue['TICK']     = tick;
                    issue['TRANSFER'] = sweep['DESTINATION'];

                    // Create a record of this action in the actions table
                    issue['ACTION_INDEX'] = await this.indexerDb.createActionIndex(issue, true);

                    // Create issue record for transfer of ownership
                    await this.indexerDb.createIssue(issue);

                    // Update tokens table to indicate new owner
                    await this.indexerDb.updateTokens(tick);
                    // console.log('creating issue for tick=',tick);

                    // Store the SOURCE, DESTINATION and TICK in addresses and tickers lists
                    this.util.addAddressTicker(issue['SOURCE'], tick);
                    this.util.addAddressTicker(issue['DESTINATION'], tick);

                    // Create action mappings for this ISSUE
                    await this.mapper.createMappings(issue);


                }
            }

        }
    }
}

module.exports = Sweep;