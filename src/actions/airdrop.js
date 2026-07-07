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
 * XChain Platform Action - AIRDROP
 * 
 * This action airdrops `TICK` supply to one or more lists.
 * 
 * PARAMS:
 * - VERSION           - Format Version
 * - TICK              - Ticker name or Ticker ID
 * - AMOUNT            - Amount of tokens to airdrop
 * - LIST_ACTION_INDEX - `ACTION_INDEX` of a `LIST`
 * - MEMO              - An optional memo to include
 * 
 * FORMATS:
 * - 0 = Single Airdrop
 * - 1 = Multi-Airdrop (Brief)
 * - 2 = Multi-Airdrop (Full)
 * - 3 = Multi-Airdrop (Full) with Multiple Memos
 * 
 ********************************************************************/

class Airdrop {

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
        this.formats[0] = 'VERSION|TICK|AMOUNT|LIST_ACTION_INDEX|MEMO';
        this.formats[1] = 'VERSION|LIST_ACTION_INDEX|TICK|AMOUNT|TICK|AMOUNT|MEMO';
        this.formats[2] = 'VERSION|TICK|AMOUNT|LIST_ACTION_INDEX|TICK|AMOUNT|LIST_ACTION_INDEX|MEMO';
        this.formats[3] = 'VERSION|TICK|AMOUNT|LIST_ACTION_INDEX|MEMO|TICK|AMOUNT|LIST_ACTION_INDEX|MEMO';

        // Define array of list types (1=Tick, 2=Address)
        this.listTypes = [1,2];
    }

    // Handle parsing the AIRDROP transaction
    async parse(params, data, error){
        // Validate that format is known
        let format = data['FORMAT'];
        if(!error && (format===null || this.formats[format] === undefined ))
            error = 'invalid: VERSION (unknown)';

        // Array of airdrops [TICK, AMOUNT, LIST, MEMO]
        let airdrops = []; 

        // Extract memo
        let memo = null;
        let last = params.length - 1;
        for(let idx in params)
            if(idx==last && ((format==0 && idx==4) || (format==1 && idx%2==0) || (format==2 && idx%3==1)))
                memo = params[idx];

        // Build out array of airdrops
        let lastIdx = params.length - 1;        
        for(let idx in params){
            // Force index to integer value
            idx = parseInt(idx);

            // Single Airdrop
            if(format==0 && idx==0)
                airdrops.push([params[1], params[2], params[3], memo]);

            // Multi-Airdrop (brief)
            if(format==1 && idx>1 && idx%2==1)
                airdrops.push([params[idx-1], params[idx], params[1], memo]);

            // Multi-Airdrop (Full)
            if(format==2 && idx>0 && idx%3==1 && idx < lastIdx)
                airdrops.push([params[idx], params[(idx+1)], params[idx+2], memo]);

            // Multi-Airdrop (Full) with Multiple Memos
            if(format==3 && idx>0 && idx%4==1 && idx < lastIdx)
                airdrops.push([params[idx], params[idx+1], params[idx+2], params[idx+3]]);
        }

        // Get token data for every TICK (reduces duplicated sql queries)
        let ticks = {};
        for(let airdrop of airdrops){
            let tick = airdrop[0];
            if(ticks[tick] === undefined)
                ticks[tick] = await this.indexerDb.getTokenInfo(tick, data['BLOCK_INDEX'], data['ACTION_INDEX']);
        }

        // Get source address balances and preferences
        let balances    = await this.indexerDb.getAddressBalances(data['SOURCE'], null, data['BLOCK_INDEX'], data['ACTION_INDEX']);
        let preferences = await this.indexerDb.getAddressPreferences(data['SOURCE'], data['BLOCK_INDEX'], data['ACTION_INDEX']);

        // Controller-bound token gas context. If the airdropped TICK's `transfer` class is bound to a
        // controller, the aggregate outbound move runs that contract's `guard` before settling and
        // SOURCE pays the (bounded) guard gas in GAS. Loaded once; the guard reserves its ceiling
        // against the live `balances` view so a denied/cheap guard can never drive GAS negative, and
        // the metered fee is reserved out of `balances` before the per-tx fee check (below) so the two
        // GAS charges are cumulative. Pre-CONTROLLER_GUARD flag-day the guard is a strict no-op.
        let gasTick = this.config['GAS'];
        let gasInfo = await this.indexerDb.getTokenInfo(gasTick, data['BLOCK_INDEX'], data['ACTION_INDEX']);

        // Create the fees object 
        let fees = await this.util.createFeesObject(this.indexerDb, data, preferences);

        // Store original error value
        let origError = error;

        // Array of credits and debits
        let credits = [],
            debits  = [];

        // Loop through airdrops and process each
        for(let idx in airdrops){

            // Parse in the airdrop information
            let info = airdrops[idx];

            // Reset error to the original value
            error = origError;

            // Copy base transaction data object
            let airdrop = data;

            // Guard gas fee billed to SOURCE for this leg (0 = uncontrolled token)
            let guardFee = 0;

            // Array of addresses that will receive this AIRDROP
            let recipients = [];

            // Placeholder for list and list type
            let type = false,
                list = null;

            // Update transaction data object with airdrop values
            airdrop['TICK']              = info[0];
            airdrop['AMOUNT']            = info[1];
            airdrop['LIST_ACTION_INDEX'] = info[2];
            airdrop['MEMO']              = info[3];

            // Get information on token
            let tokenInfo = ticks[airdrop['TICK']];

            // Convert NUMBER fields from string value to number value so comparisons are mathematical 
            if(!error)
                data = this.util.setNumberFormats(data);

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
            if(!error && !this.util.isNull(airdrop['AMOUNT']) && !this.util.isValidAmountFormat(tokenInfo['DECIMALS'], airdrop['AMOUNT']))
                error = "invalid: AMOUNT (format)";

            // Verify LIST format
            if(!error && !this.util.isNull(airdrop['LIST_ACTION_INDEX']) && !this.util.isNumeric(airdrop['LIST_ACTION_INDEX']))
                error = "invalid: LIST_ACTION_INDEX (format)";

            /*************************************************************
             * General Validations
             ************************************************************/

            // Verify SOURCE is not sleeping
            if(!error && await this.indexerDb.isActionAllowed(airdrop['SOURCE'], null, airdrop['BLOCK_INDEX']) == false)
                error = 'invalid: SOURCE (sleeping)';

            // Verify TICK is not sleeping
            if(!error && await this.indexerDb.isActionAllowed(null, airdrop['TICK'], airdrop['BLOCK_INDEX']) == false)
                error = 'invalid: TICK (sleeping)';

            // Verify no pipe in MEMO (pipe is field delimiter)
            if(!error && String(airdrop['MEMO']).indexOf('|')!=-1)
                error = 'invalid: MEMO (pipe)';

            // Verify no semicolon in MEMO (semicolon is action delimiter)
            if(!error && String(airdrop['MEMO']).indexOf(';')!=-1)
                error = 'invalid: MEMO (semicolon)';

            // Verify MEMO is shorter than MAX_MEMO_LENGTH
            if(!error && String(airdrop['MEMO']).length > this.config['MAX_MEMO_LENGTH'])
                error = 'invalid: MEMO (length)';

            // Lookup list information
            if(!error){
                type = await this.indexerDb.getListType(airdrop['LIST_ACTION_INDEX']);
                list = await this.indexerDb.getList(airdrop['LIST_ACTION_INDEX']);
            }

            // Verify LIST exist
            if(!error && type===false)
                error = 'invalid: LIST (unknown)';

            // Verify LIST type is supported
            if(!error && !this.listTypes.includes(type))
                error = 'invalid: LIST TYPE (unsupported)';

            // Handle TICK LIST by looking up holders and adding to recipients list
            if(!error && this.listTypes.indexOf(type)!=-1){
                let holders = {};
                for(let tick of list){
                    if(type==1)
                        holders = await this.indexerDb.getHolders(tick, data['BLOCK_INDEX'], data['ACTION_INDEX']);
                    for(let address in holders){
                        if(recipients.indexOf(address)==-1)
                            recipients.push(address);
                    }
                }
            }

            // Handle ADDRESS LIST by passing forward addresses to recipients list
            if(!error && type==2)
                recipients = list;

            // Verify TICK action is allowed from SOURCE (allow/block lists)
            if(!error && await this.indexerDb.isActionAllowed(airdrop['SOURCE'], airdrop['TICK']) == false)
                error = 'invalid: SOURCE (not authorized)';

            // Verify SOURCE has enough balances to cover airdrop AMOUNT
            if(!error && await this.util.hasBalance(balances, tokenInfo['TICK_ID'], airdrop['AMOUNT']) == false)
                error = 'invalid: insufficient funds';

            // Build out array of recipient addresses that are allowed to receive the airdrop
            let approved = [];

            // Verify airdrop is allowed to recipient (allow/block lists)
            for(let address of recipients){
                if(approved.indexOf(address)==-1 && await this.indexerDb.isActionAllowed(address, airdrop['TICK']))
                    approved.push(address);
            }

            // Update recipients list to only do airdrops to addresses which allow it
            recipients = approved;

            // Determine total DEBIT
            airdrop['DEBIT'] = (!error) ? this.util.bcmul(recipients.length, airdrop['AMOUNT'], tokenInfo['DECIMALS']) : 0;

            // Determine total transaction FEE
            let unifiedFees = await this.actions.protocolChanges.isEnabled('UNIFIED_FEES', data['BLOCK_INDEX']);
            if(unifiedFees){
                // Unified gas schedule: per-recipient gas
                let result = this.util.getUnifiedTransactionFee(recipients.length, 'AIRDROP_PER_RECIPIENT');
                fees['GAS_COST']    = result.gasCost;
                fees['AMOUNT']      = result.fee;
                fees['FEE_VERSION'] = 2;
            } else {
                // Legacy: database hits model
                let db_hits  = recipients.length * 2;
                    db_hits += 3;
                fees['AMOUNT'] = this.util.getTransactionFee(db_hits, fees['TICK']);
            }
            // Emitted (VM-synthesized) actions pay no separate per-tx fee. See util.feeForAction
            // (the airdrop DEBIT to recipients is unaffected).
            fees['AMOUNT'] = this.util.feeForAction(fees['AMOUNT'], data);

            // Verify SOURCE has enough balances to cover TICK total DEBIT amount
            if(!error && !this.util.hasBalance(balances, tokenInfo['TICK_ID'], airdrop['DEBIT']))
                error = 'invalid: insufficient funds (TICK)';
        
            // Adjust balances to reduce by DEBIT amount
            if(!error)
                balances = this.util.debitBalances(balances, tokenInfo['TICK_ID'], airdrop['DEBIT']);

            // Controller-bound token: the airdropped TICK's bound contract gates the AGGREGATE
            // outbound move once (from=SOURCE, amount=total DEBIT, no single recipient). The guard
            // may DENY (revert the whole airdrop leg) or bill metered gas. Reserve the guard ceiling
            // against the live GAS balance and, on allow, reduce `balances` by the metered fee BEFORE
            // the per-tx fee check so a holder short on GAS can't pass the fee check yet be over-debited
            // by the guard fee (which would drive GAS negative and trip sanityCheck). Runs after all
            // other validation, so an allow leads directly to a valid airdrop. Flag-gated no-op pre-day.
            if(!error && tokenInfo){
                let result = await this.util.maybeRunControllerGuard(this.actions, this.indexerDb, {
                    actionType:  'AIRDROP',
                    tick:        airdrop['TICK'],
                    from:        data['SOURCE'],
                    to:          '',
                    amount:      airdrop['DEBIT'],
                    data:        airdrop,
                    gasInfo:     gasInfo,
                    gasBalances: balances,
                    seq:         parseInt(idx) || 0
                });
                if(result.error){
                    error = 'invalid: ' + result.error;
                } else if(this.util.bcgt(result.guardFee, 0)){
                    guardFee = result.guardFee;
                    if(gasInfo)
                        balances = this.util.debitBalances(balances, gasInfo['TICK_ID'], guardFee);
                }
            }

            // Validate fee payment (native coin or XCHAIN balance)
            if(!error && this.util.bcgt(fees['AMOUNT'], 0)){
                let paymentMode = this.util.detectFeePaymentMode(data, this.decoderDb, data['TX_OUTPUTS']);
                if(paymentMode === 'native'){
                    let validation = await this.util.validateNativeCoinFee(data, fees, this.indexerDb, data['TX_OUTPUTS']);
                    if(!validation.valid){
                        error = 'invalid: ' + (validation.error || 'native coin fee validation failed');
                    } else {
                        fees['PAYMENT_MODE']       = 1;
                        fees['NATIVE_COIN_AMOUNT'] = validation.nativeCoinAmount;
                        fees['NATIVE_COIN']        = validation.nativeCoin;
                        fees['ORACLE_ROUND']       = validation.oracleRound;
                    }
                } else if(paymentMode === 'rejected'){
                    error = 'invalid: insufficient fee (native coin output required)';
                } else {
                    if(!this.util.hasBalance(balances, fees['TICK_ID'], fees['AMOUNT']))
                        error = 'invalid: insufficient funds (FEE)';
                }
            }

            // Adjust balances to reduce by FEE AMOUNT (only for XCHAIN deduction mode)
            if(!error && (!fees['PAYMENT_MODE'] || fees['PAYMENT_MODE'] === 2))
                balances = this.util.debitBalances(balances, fees['TICK_ID'], fees['AMOUNT']);

            // Determine final status
            let status = (error) ? error : 'valid';
            data['STATUS'] = airdrop['STATUS'] = status;
    
            // Print status message 
            console.log("\t AIRDROP : " + airdrop['TICK'] + ' : ' + airdrop['AMOUNT'] + ' : '+ airdrop['STATUS']);
    
            // Create record in airdrop table
            await this.indexerDb.createAirdrop(airdrop);
    
            // Store the SOURCE and TICK in addresses list
            this.util.addAddressTicker(data['SOURCE'], airdrop['TICK']);

            // If we are charging a fee, store the SOURCE and fees TICK in addresses list
            if(this.util.bcgt(fees['AMOUNT'], 0))
                this.util.addAddressTicker(data['SOURCE'], fees['TICK']);

            // If this was a valid transaction, then add records to the credits and debits array
            if(status=='valid'){

                // Add ticker, amount, and address to debits array
                debits.push([airdrop['TICK'], airdrop['DEBIT'], data['SOURCE']]);

                // Bill the controller-guard gas to SOURCE (a GAS burn with no offsetting credit). The
                // end-of-action updateTokens recomputes GAS supply from the ledger so the per-block
                // sanityCheck (ledger == supply == balances) holds. `balances` was already reduced above.
                if(this.util.bcgt(guardFee, 0)){
                    debits.push([gasTick, guardFee, data['SOURCE']]);
                    this.util.addAddressTicker(data['SOURCE'], gasTick);
                }

                // Handle any transaction FEE according the users's ADDRESS preferences
                [credits, debits] = await this.util.processTransactionFees(this.indexerDb, credits, debits, fees);

                // Loop through recipient addresses
                for(let address of recipients){

                    // Store the recipient ADDRESS and TICK in addresses list
                    this.util.addAddressTicker(address, airdrop['TICK']);
        
                    // Credit address with TICK AMOUNT
                    credits.push([airdrop['TICK'], airdrop['AMOUNT'], address]);
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

module.exports = Airdrop;