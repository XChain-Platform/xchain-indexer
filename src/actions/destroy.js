/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Platform Action - DESTROY
 * 
 * This action destroys `TICK` supply.
 * 
 * PARAMS:
 * - VERSION - Format Version
 * - TICK    - Ticker name or Ticker ID
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
        // Setup short aliases
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;
        
        // Define list of known FORMATS
        this.formats = {};
        this.formats[0] = 'VERSION|TICK|AMOUNT|MEMO';
        this.formats[1] = 'VERSION|TICK|AMOUNT|TICK|AMOUNT|MEMO';
        this.formats[2] = 'VERSION|TICK|AMOUNT|MEMO|TICK|AMOUNT|MEMO';
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
        // data['FORMAT'] = this.util.getFormatVersion(params[0]);

        // Validate that format is known
        let format = data['FORMAT'];
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
            // A trailing memo (when present) always sits at the odd last index, so the
            // idx%2==0 test already excludes it; the extra `idx < lastIdx` guard wrongly
            // dropped the final tick/amount pair whenever no trailing memo was supplied.
            if(format==1 && idx>1 && idx%2==0)
                destroys.push([params[idx-1], params[idx], memo]);

            // Multi-Destroy (Full) with Multiple Memos
            if(format==2 && idx>0 && idx%3==1 && idx < lastIdx)
                destroys.push([params[idx], params[(idx+1)], params[idx+2], params[idx+3]]);
        }

        // Get token data for every TICK (reduces duplicated sql queries)
        let ticks = {};
        for(let destroy of destroys){
            let tick = destroy[0];
            if(ticks[tick] === undefined)
                ticks[tick] = await this.indexerDb.getTokenInfo(tick, data['BLOCK_INDEX'], data['ACTION_INDEX']);
        }

        // Consolidate destroys by TICK and MEMO
        let keys = {};
        for(let info of destroys){
            let [tick, amount, memo] = info;
            let key = tick + '|' + memo;
            if(!this.util.isNull(keys[key]))
                amount = this.util.bcadd(amount, keys[key][1], ticks[tick] && ticks[tick]['DECIMALS']);
            keys[key] = [tick, amount, memo];
        }

        // Update destroys using consolidated info
        destroys = [];
        for(let key in keys)
            destroys.push(keys[key]);

        // Get source address balances
        let balances = await this.indexerDb.getAddressBalances(data['SOURCE'], null, data['BLOCK_INDEX'], data['ACTION_INDEX']);

        // Controller-bound token gas context. A DESTROY of a token whose `burn` class is bound to a
        // controller runs that contract's `guard` before the burn settles; the SOURCE pays the
        // (bounded) guard gas. Load the SOURCE's GAS balance once so a multi-destroy debits it
        // cumulatively across controlled legs (maybeRunControllerGuard reserves the ceiling).
        let gasTick     = this.config['GAS'];
        let gasInfo     = await this.indexerDb.getTokenInfo(gasTick, data['BLOCK_INDEX'], data['ACTION_INDEX']);
        let gasBalances = await this.indexerDb.getAddressBalances(data['SOURCE'], gasTick, data['BLOCK_INDEX'], data['ACTION_INDEX']);

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

            // Convert NUMBER fields from string value to number value so comparisons are mathematical 
            if(!error)
                destroy = this.util.setNumberFormats(destroy);

            // Get information on token
            let tokenInfo = ticks[destroy['TICK']];

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
            if(!error && !this.util.isNull(destroy['AMOUNT']) && !this.util.isValidAmountFormat(tokenInfo['DECIMALS'], destroy['AMOUNT']))
                error = "invalid: AMOUNT (format)";

            /*************************************************************
             * General Validations
             ************************************************************/

            // Verify SOURCE is not sleeping
            if(!error && await this.indexerDb.isActionAllowed(destroy['SOURCE'], null, destroy['BLOCK_INDEX']) == false)
                error = 'invalid: SOURCE (sleeping)';

            // Verify TICK is not sleeping
            if(!error && await this.indexerDb.isActionAllowed(null, destroy['TICK'], destroy['BLOCK_INDEX']) == false)
                error = 'invalid: TICK (sleeping)';

            // Verify no pipe in MEMO (pipe is field delimiter)
            if(!error && String(destroy['MEMO']).indexOf('|')!=-1)
                error = 'invalid: MEMO (pipe)';

            // Verify no semicolon in MEMO (semicolon is action delimiter)
            if(!error && String(destroy['MEMO']).indexOf(';')!=-1)
                error = 'invalid: MEMO (semicolon)';

            // Verify MEMO is shorter than MAX_MEMO_LENGTH
            if(!error && String(destroy['MEMO']).length > this.config['MAX_MEMO_LENGTH'])
                error = 'invalid: MEMO (length)';

            // Verify TICK action is allowed from SOURCE (allow/block lists)
            if(!error && await this.indexerDb.isActionAllowed(destroy['SOURCE'], destroy['TICK']) == false)
                error = 'invalid: SOURCE (not authorized)';

            // Verify SOURCE has enough balances to cover destroy
            if(!error && !this.util.hasBalance(balances, tokenInfo['TICK_ID'], destroy['AMOUNT']))
                error = 'invalid: insufficient funds';

            // Guard gas fee billed to SOURCE for this leg (0 = uncontrolled token)
            let guardFee = 0;

            // Controller-bound token: the token's `burn` controller must approve destroying it.
            if(!error && tokenInfo){
                let result = await this.util.maybeRunControllerGuard(this.actions, this.indexerDb, {
                    actionType:  'DESTROY',
                    tick:        destroy['TICK'],
                    from:        destroy['SOURCE'],
                    to:          '',
                    amount:      destroy['AMOUNT'],
                    data:        destroy,
                    gasInfo:     gasInfo,
                    gasBalances: gasBalances,
                    seq:         parseInt(idx) || 0
                });
                if(result.error)
                    error = 'invalid: ' + result.error;
                else
                    guardFee = result.guardFee;
            }

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
    
            // Store the SOURCE and TICK in addresses list
            this.util.addAddressTicker(destroy['SOURCE'], destroy['TICK']);

            // If this was a valid transaction, then add records to the credits and debits array
            if(status=='valid'){

                // Add ticker and amount to debits array
                debits.push([destroy['TICK'], destroy['AMOUNT'], destroy['SOURCE']]);

                // Bill the controller-guard gas to SOURCE (in GAS). Reduce the in-memory GAS
                // balance so a later controlled leg in this same multi-destroy sees the spend.
                if(this.util.bcgt(guardFee, 0)){
                    debits.push([gasTick, guardFee, destroy['SOURCE']]);
                    this.util.addAddressTicker(destroy['SOURCE'], gasTick);
                    if(gasInfo)
                        gasBalances = this.util.debitBalances(gasBalances, gasInfo['TICK_ID'], guardFee);
                }
            }
        }

        // Process any transaction ledger changes (credits / debits)
        await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits);

        // Get a list of tickers & addresses
        let tickers   = this.util.getTickersList(),
            addresses = Object.keys(this.util.getAddressesList());

        // Update address balances and token supply
        await this.indexerDb.updateBalances(addresses);
        await this.indexerDb.updateTokens(tickers);

        // Create action mappings
        await this.mapper.createMappings(data);
    }
}

module.exports = Destroy;