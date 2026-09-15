const { getLogger } = require('../../observability/index.js');
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
 * XChain Platform Action - CALLBACK
 * 
 * This action performs a callback on a `TICK`. 
 * 
 * PARAMS:
 * - VERSION - Format Version
 * - TICK    - Ticker name or Ticker ID
 * - MEMO    - An optional memo to include
 * 
 * FORMATS:
 * - 0 = Full
 * 
 ********************************************************************/

// The TICK, general and funding validations (./validate.js). Each is called with
// this handler as the receiver, so the checks read this.indexerDb / this.util /
// this.config unchanged and the error they settle on does not depend on the file.
const validate = require('./validate.js');

class Callback {

    // Handle constructing a class instance
    constructor(action){
        // Setup short aliases
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;

        this.formats = {};
        this.formats[0] = 'VERSION|TICK|MEMO';
    }

    // Handle parsing the CALLBACK transaction
    async parse(params, data, error){
        /*****************************************************************
         * DEBUGGING - Force params
         ****************************************************************/
        // Example payloads by FORMAT version:
        // let str    = "0|SAT|Testing";
        // params = String(str).split('|');
        // data['FORMAT'] = this.util.getFormatVersion(params[0]);

        // Validate that format is known
        let format = data['FORMAT'];
        if(!error && (format===null || this.formats[format] === undefined ))
            error = 'invalid: VERSION (unknown)';

        // Parse PARAMS using given VERSION format and update transaction data object
        if(!error)
            data = this.util.setActionParams(data, params, this.formats, format);

        let s = await this.loadCallbackState(data);
        let callback = s.callback;
        let totals = this.buildCallbackTotals(data, s.tokenInfo, s.callbackTokenInfo, s.holders, s.allowList, s.blockList, s.recipients);
        await this.chargeCallbackFee(data, s.fees, s.recipients);
        error = await validate.validateCallbackToken.call(this, data, s.tokenInfo, s.callbackTokenInfo, error);
        error = await validate.validateCallbackState.call(this, data, s.tokenInfo, error);
        error = await validate.validateCallbackFunding.call(this, data, s, error, totals.totalCallbackTickAmount);
        // Determine final status
        let status = (error) ? error : 'valid';
        data['STATUS'] = callback['STATUS'] = status;

        // Print status message
        getLogger().info("\t CALLBACK : " + data['TICK'] + ' : '  +  data['MEMO'] + ' : ' + data['STATUS']);

        // Create record in callback table
        await this.indexerDb.createCallback(callback);

        // Store the SOURCE, TICK, and CALLBACK_TICK in addresses list
        this.util.addAddressTicker(data['SOURCE'], [callback['TICK'], callback['CALLBACK_TICK']]);

        // If this was a valid transaction, then create the credit and debit records
        if(status=='valid'){

            let ledger = await this.buildCallbackLedger(data, callback, s.fees, s.holders, totals.totalTickAmount, totals.totalCallbackTickAmount);
            await this.applyCallbackLedger(data, callback, s.recipients, ledger.credits, ledger.debits);
        }

        // Create action mappings
        await this.mapper.createMappings(data);
    }
    // Everything the phases below read: the callback row, both tokens, the SOURCE's balances
    // and preferences, the holders, the CALLBACK_TICK lists, the fees object and recipients.
    async loadCallbackState(data){
        // Clone the raw data for storage in callbacks table
        let callback = Object.assign({}, data);

        // Get information on token and callback token
        let tokenInfo         = await this.indexerDb.getTokenInfo(data['TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX']);
        let callbackTokenInfo = (tokenInfo) ? await this.indexerDb.getTokenInfo(tokenInfo['CALLBACK_TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX']) : null;

        // Get source address balances and preferences, as well as TICK holders list
        let balances    = await this.indexerDb.getAddressBalances(data['SOURCE'], null, data['BLOCK_INDEX'], data['ACTION_INDEX']);
        let preferences = await this.indexerDb.getAddressPreferences(data['SOURCE'], data['BLOCK_INDEX'], data['ACTION_INDEX']);
        let holders     = await this.indexerDb.getHolders(data['TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX']);

        // List of addresses allowed or blocked from holding CALLBACK_TICK
        // Held as Sets: the holder loop below probes membership once per holder, so an O(1)
        // hash probe replaces a scan of the whole list. Emptiness still gates the check, so a
        // configured-but-empty ALLOW_LIST keeps admitting everyone exactly as before.
        let allowList = (callbackTokenInfo && callbackTokenInfo['ALLOW_LIST']) ? new Set(await this.indexerDb.getList(callbackTokenInfo['ALLOW_LIST'], data['BLOCK_INDEX'])) : new Set();
        let blockList = (callbackTokenInfo && callbackTokenInfo['BLOCK_LIST']) ? new Set(await this.indexerDb.getList(callbackTokenInfo['BLOCK_LIST'], data['BLOCK_INDEX'])) : new Set();

        // Create the fees object
        let fees = await this.util.createFeesObject(this.indexerDb, data, preferences);

        // recipients['address'] = amount of CALLBACK_TICK owed to that address
        let recipients = {};

        // Convert NUMBER fields from string value to number value so comparisons are mathematical
        if(tokenInfo){
            tokenInfo = this.util.setNumberFormats(tokenInfo);
            // Populate callback object with callback data
            callback['CALLBACK_TICK']   = tokenInfo['CALLBACK_TICK'];
            callback['CALLBACK_AMOUNT'] = tokenInfo['CALLBACK_AMOUNT'];
        }

        return { callback: callback, tokenInfo: tokenInfo, callbackTokenInfo: callbackTokenInfo, balances: balances,
                 preferences: preferences, holders: holders, allowList: allowList, blockList: blockList,
                 fees: fees, recipients: recipients };
    }

    // The per-holder tally: who is owed CALLBACK_TICK, and the TICK and CALLBACK_TICK totals.
    buildCallbackTotals(data, tokenInfo, callbackTokenInfo, holders, allowList, blockList, recipients){
        // Placeholders for total amounts for TICK and CALLBACK_TICK
        let totalTickAmount         = 0;
        let totalCallbackTickAmount = 0;

        // Loop through list of holders and build out valid recipients list and calculate total TICK and CALLBACK_TICK amounts
        if(tokenInfo){
            for(let address in holders){
                let valid  = true;

                // Ignore the source address so it is not included in calculations
                if(address==data['SOURCE'])
                   continue;

                // Check if recipient is on the allow or block lists and only add valid addresses to the recipients list
                if((allowList.size && !allowList.has(address)) || (blockList.size && blockList.has(address)))
                    valid = false;

                if(valid){
                    // AMOUNT owed = BALANCE * CALLBACK_AMOUNT, rounded to the callback tick's decimals
                    let cbDecimals = callbackTokenInfo ? callbackTokenInfo['DECIMALS'] : 0;
                    let amount = this.util.bcmulfloor(holders[address], tokenInfo['CALLBACK_AMOUNT'], cbDecimals);

                    // Add address and AMOUNT to the recipients list
                    recipients[address]  = amount;
                    // Add CALLBACK_TICK amount to totalCallbackTickAmount
                    totalCallbackTickAmount = this.util.bcadd(totalCallbackTickAmount, amount, cbDecimals)
                }

                // Add TICK amount to totalTickAmount
                totalTickAmount = this.util.bcadd(totalTickAmount, holders[address], tokenInfo['DECIMALS'])
            }
        }

        return { totalTickAmount: totalTickAmount, totalCallbackTickAmount: totalCallbackTickAmount };
    }

    // Price the transaction onto the fees object: unified gas schedule or the legacy db-hits model.
    async chargeCallbackFee(data, fees, recipients){
        // Determine the total transaction FEE. UNIFIED_FEES_SWEEP_CALLBACK gates the move off
        // the legacy per-DB-hit model: the legacy price has no floor, so on LTC/DOGE (where
        // detectFeePaymentMode REJECTS a missing native-coin fee output rather than falling
        // back to an XCHAIN debit) a small CALLBACK priced below the chain's dust threshold
        // and could not be submitted at all. Below the flag-day the legacy model is
        // reproduced exactly so a pre-activation replay commits the identical fee. See
        // protocol_changes.js.
        let unifiedFees = await this.actions.protocolChanges.isEnabled('UNIFIED_FEES_SWEEP_CALLBACK', data['BLOCK_INDEX']);
        if(unifiedFees){
            // Unified gas schedule: a flat base plus per-recipient gas, at DIVIDEND/AIRDROP
            // per-recipient parity. `recipients` is the post-ALLOW_LIST/BLOCK_LIST set the
            // settlement block below credits, which is the same count the legacy db_hits term
            // used, so only the price changes.
            let result = this.util.getUnifiedBaseItemFee(Object.keys(recipients).length, 'CALLBACK_BASE', 'CALLBACK_PER_RECIPIENT');
            fees['GAS_COST']    = result.gasCost;
            fees['AMOUNT']      = result.fee;
            fees['FEE_VERSION'] = 2;
        } else {
            // Legacy: database hits model. LEGACY_FEE_NUMERIC_DBHITS gates the db_hits
            // string-concatenation fix: below THAT flag-day reproduce the original
            // `+= bcmul(...)` concatenation byte-for-byte (4 + "6" -> "46") for
            // pre-activation replay parity; at/above it accumulate numerically. See
            // protocol_changes.js.
            let numericDbHits = await this.actions.protocolChanges.isEnabled('LEGACY_FEE_NUMERIC_DBHITS', data['BLOCK_INDEX']);
            let db_hits = 4;                                                                   // 1 debits, 1 credits, 1 balances, 1 callback
            if(numericDbHits)
                db_hits += (recipients) ? Number(Object.keys(recipients).length) * 3 : 0;      // 1 debits, 1 credits, 1 balances
            else
                db_hits += (recipients) ? this.util.bcmul(Object.keys(recipients).length, 3, 0) : 0;
            fees['AMOUNT'] = this.util.getTransactionFee(db_hits, fees['TICK']);
        }

        // Determine total transaction FEE based on database hits.
        // Emitted (VM-synthesized) actions pay no separate per-tx fee; see util.feeForAction.
        fees['AMOUNT'] = this.util.feeForAction(fees['AMOUNT'], data);

    }

    // The ledger a valid CALLBACK writes: the holders' TICK moves to the SOURCE, the SOURCE pays
    // the CALLBACK_TICK total, and the fee is routed by the payer's preferences.
    async buildCallbackLedger(data, callback, fees, holders, totalTickAmount, totalCallbackTickAmount){
        // Array of credits and debits (tick, amount, address)
        let credits = [],
            debits  = [];

        // If we are charging a fee, store the SOURCE and fees TICK in addresses list
        if(this.util.bcgt(fees['AMOUNT'], 0))
            this.util.addAddressTicker(data['SOURCE'], fees['TICK']);

        // Loop through list of holders
        for(let address in holders){

            // Ignore the source address so it is not debited what it is holding
            if(address==data['SOURCE'])
               continue;

            // Create debit record to callback the TICK to SOURCE
            debits.push([callback['TICK'], holders[address], address]);

            // Store the holder ADDRESS and TICK in addresses list
            this.util.addAddressTicker(address, callback['TICK']);
        }

        // Create credit record for TICK total to SOURCE
        credits.push([callback['TICK'], totalTickAmount, callback['SOURCE']]);

        // Create debit record for CALLBACK_TICK total from SOURCE
        debits.push([callback['CALLBACK_TICK'], totalCallbackTickAmount, callback['SOURCE']]);

        // Handle any transaction FEE according the users's ADDRESS preferences
        [credits, debits] = await this.util.processTransactionFees(this.indexerDb, credits, debits, fees);

        return { credits: credits, debits: debits };
    }

    // Credit each recipient its CALLBACK_TICK, write the ledger changes, and refresh the
    // balances and token supplies they moved.
    async applyCallbackLedger(data, callback, recipients, credits, debits){
        // Loop through recipient addresses
        for(let address in recipients){

            // Store the recipient ADDRESS and TICK in addresses list
            this.util.addAddressTicker(address, callback['CALLBACK_TICK']);

            credits.push([callback['CALLBACK_TICK'], recipients[address], address]);
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

}

module.exports = Callback;