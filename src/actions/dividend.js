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
 * XChain Platform Action - DIVIDEND
 * 
 * This action pays a dividend to holders of `TICK`.
 * 
 * PARAMS:
 * - VERSION        - Format Version
 * - TICK           - Ticker name or Ticker ID
 * - DIVIDEND_TICK  - Ticker name or Ticker ID
 * - AMOUNT         - The quantity of DIVIDEND_TICK rewarded per UNIT
 * - MEMO           - An optional memo to include
 * 
 * FORMATS:
 * - 0 = Full
 * 
 ********************************************************************/

class Dividend {

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
        this.formats[0] = 'VERSION|TICK|DIVIDEND_TICK|AMOUNT|MEMO';
    }

    // Handle parsing the DIVIDEND transaction
    async parse(params, data, error){
        // Validate that format is known
        let format = data['FORMAT'];
        if(!error && (format===null || this.formats[format] === undefined ))
            error = 'invalid: VERSION (unknown)';

        // Parse PARAMS using given VERSION format and update transaction data object
        if(!error)
            data = this.util.setActionParams(data, params, this.formats, format);

        // Clone the raw data for storage in dividends table
        let dividend = Object.assign({}, data);

        // Convert NUMBER fields from string value to number value so comparisons are mathematical 
        if(!error)
            data = this.util.setNumberFormats(data);

        // Get source address balances and preferences, as well as TICK holders list
        let balances    = await this.indexerDb.getAddressBalances(data['SOURCE'], null, data['BLOCK_INDEX'], data['ACTION_INDEX']);
        let preferences = await this.indexerDb.getAddressPreferences(data['SOURCE'], data['BLOCK_INDEX'], data['ACTION_INDEX']);
        let holders     = await this.indexerDb.getHolders(data['TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX']);

        // Get token information on TICK and DIVIDEND_TICK
        let tokenInfo         = await this.indexerDb.getTokenInfo(data['TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX']);
        let dividendTokenInfo = await this.indexerDb.getTokenInfo(data['DIVIDEND_TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX']);

        // Create the fees object 
        let fees = await this.util.createFeesObject(this.indexerDb, data, preferences);

        // List of recipients which will receive this DIVIDEND
        // Format: recipients['address'] = amount;
        let recipients = {};

        // List of addresses allowed or blocked from holding DIVIDEND_TICK
        let allowList = (dividendTokenInfo && dividendTokenInfo['ALLOW_LIST']) ? await this.indexerDb.getList(dividendTokenInfo['ALLOW_LIST']) : [];
        let blockList = (dividendTokenInfo && dividendTokenInfo['BLOCK_LIST']) ? await this.indexerDb.getList(dividendTokenInfo['BLOCK_LIST']) : [];

        // Loop through list of holders and build out valid recipients list
        dividend['DEBIT'] = 0;
        if(dividendTokenInfo){
            for(let address in holders){
                let valid = true;
                // Check if recipient is on the allow or block lists and only add valid addresses to the recipients list
                if((allowList.length && !allowList.includes(address)) || (blockList.length && blockList.includes(address)))
                    valid = false;
                // Ignore the source address so it is not added to recipients list
                if(address==data['SOURCE'])
                    valid = false;
                // Add address to the recipients list and calculate AMOUNT of the DIVIDEND_TICK the address should receive
                // Skip holders whose calculated share rounds to 0 (e.g. fractional TICK balances when DIVIDEND_TICK is
                // non-divisible) - they receive no DIVIDEND_TICK, so they must not count toward the per-recipient fee.
                if(valid){
                    let share = this.util.bcmulfloor(holders[address], data['AMOUNT'], dividendTokenInfo['DECIMALS']);
                    if(share != 0)
                        recipients[address] = share;
                }
            }

            // Determine total DEBIT for this dividend using recipient list
            let totalDebit = 0;
            for(let address in recipients)
                totalDebit = this.util.bcadd(totalDebit, recipients[address], dividendTokenInfo['DECIMALS'])
            dividend['DEBIT'] = totalDebit;
        }

        /*****************************************************************
         * TICK Validations
         ****************************************************************/

        // Validate TICK exists
        if(!error && !tokenInfo)
            error = 'invalid: TICK (unknown)';

        // Validate DIVIDEND_TICK exists
        if(!error && !dividendTokenInfo)
            error = 'invalid: DIVIDEND_TICK (unknown)';

        /*****************************************************************
         * FORMAT Validations
         ****************************************************************/

        // Verify AMOUNT format valid for DIVIDEND_TICK
        if(!error && (this.util.isNull(data['AMOUNT']) || !this.util.isValidAmountFormat(dividendTokenInfo['DECIMALS'], data['AMOUNT'])))
            error = "invalid: AMOUNT (format)";

        /*****************************************************************
         * General Validations
         ****************************************************************/

        // Verify SOURCE is not sleeping
        if(!error && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
            error = 'invalid: SOURCE (sleeping)';

        // Verify TICK is not sleeping
        if(!error && await this.indexerDb.isActionAllowed(null, data['TICK'], data['BLOCK_INDEX']) == false)
            error = 'invalid: TICK (sleeping)';

        // Verify DIVIDEND_TICK is not sleeping
        if(!error && await this.indexerDb.isActionAllowed(null, data['DIVIDEND_TICK'], data['BLOCK_INDEX']) == false)
            error = 'invalid: DIVIDEND_TICK (sleeping)';

        // Verify no pipe in MEMO (pipe is field delimiter)
        if(!error && !this.util.isNull(data['MEMO']) && String(data['MEMO']).indexOf('|')!=-1)
            error = 'invalid: MEMO (pipe)';

        // Verify no semicolon in MEMO (semicolon is action delimiter)
        if(!error && !this.util.isNull(data['MEMO']) && String(data['MEMO']).indexOf(';')!=-1)
            error = 'invalid: MEMO (semicolon)';

        // Verify MEMO is shorter than MAX_MEMO_LENGTH
        if(!error && String(data['MEMO']).length > this.config['MAX_MEMO_LENGTH'])
            error = 'invalid: MEMO (length)';

        // Determine total transaction FEE
        let unifiedFees = await this.actions.protocolChanges.isEnabled('UNIFIED_FEES', data['BLOCK_INDEX']);
        if(unifiedFees){
            // Unified gas schedule: per-recipient gas
            let recipientCount = (recipients) ? Object.keys(recipients).length : 0;
            let result = this.util.getUnifiedTransactionFee(recipientCount, 'DIVIDEND_PER_RECIPIENT');
            fees['GAS_COST']    = result.gasCost;
            fees['AMOUNT']      = result.fee;
            fees['FEE_VERSION'] = 2;
        } else {
            // Legacy: database hits model
            let db_hits = 3;
                db_hits += (recipients) ? this.util.bcmul(Object.keys(recipients).length,2,0) : 0;
            fees['AMOUNT'] = this.util.getTransactionFee(db_hits, fees['TICK']);
        }
        // Emitted (VM-synthesized) actions pay no separate per-tx fee; see util.feeForAction
        // (the dividend DEBIT to holders is unaffected).
        fees['AMOUNT'] = this.util.feeForAction(fees['AMOUNT'], data);

        // Verify SOURCE has enough balances to cover DIVIDEND_TICK total DEBIT amount
        if(!error && !this.util.hasBalance(balances, dividendTokenInfo['TICK_ID'], dividend['DEBIT']))
            error = 'invalid: insufficient funds (TICK)';
    
        // Adjust balances to reduce by DIVIDEND_TICK total DEBIT amount
        if(!error)
            balances = this.util.debitBalances(balances, dividendTokenInfo['TICK_ID'], dividend['DEBIT']);

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

        // // Determine final status
        let status = (error) ? error : 'valid';
        data['STATUS'] = dividend['STATUS'] = status;

        // Print status message 
        console.log("\t DIVIDEND : " + dividend['TICK'] + ' : ' + dividend['DIVIDEND_TICK'] + ' : ' + dividend['AMOUNT'] + ' : ' + dividend['STATUS']);

        // Create record in dividends table
        await this.indexerDb.createDividend(dividend);

        // Store the SOURCE and TICK in addresses list
        this.util.addAddressTicker(data['SOURCE'], fees['TICK']);

        // If this was a valid transaction, then create the credit and debit records
        if(status=='valid'){

            // Array of credits and debits
            let credits = [],
                debits  = [];

            // Add DIVIDEND_TICK and DEBIT to debits array
            debits.push([dividend['DIVIDEND_TICK'], dividend['DEBIT'], dividend['SOURCE']]);

            // Handle any transaction FEE according the users's ADDRESS preferences
            [credits, debits] = await this.util.processTransactionFees(this.indexerDb, credits, debits, fees);

            // Loop through recipient addresses
            for(let address in recipients){

                // Store the recipient ADDRESS and TICK in addresses list
                this.util.addAddressTicker(address, dividend['DIVIDEND_TICK']);
    
                // Credit address with DIVIDEND_TICK AMOUNT
                credits.push([dividend['DIVIDEND_TICK'], recipients[address], address]);
            }

            // Process any transaction ledger changes (credits / debits)
            await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits);

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

module.exports = Dividend;