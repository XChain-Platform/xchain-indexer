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

// The handler's phases, grouped by concern and installed onto Dividend.prototype below:
// validate.js judges the action, fees.js prices the fee and validates its payment,
// controller_guard.js runs the bound guard, settle.js stages the DEBIT, records and applies
// the ledger. Reading the context and building the recipient list stay in this file.
const validatePart        = require('./validate.js');
const feesPart            = require('./fees.js');
const controllerGuardPart = require('./controller_guard.js');
const settlePart          = require('./settle.js');

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
        /*****************************************************************
         * DEBUGGING - Force params
         ****************************************************************/
        // Example payloads by FORMAT version:
        // let str = '0|SAT|SAT|1|testing dividends';
        // params = String(str).split('|');
        // data['FORMAT'] = this.util.getFormatVersion(params[0]);

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

        // SOURCE balances and preferences, the TICK holders and three tokens' info (loadDividendContext)
        let ctx = await this.loadDividendContext(data);

        // Create the fees object
        let fees = await this.util.createFeesObject(this.indexerDb, data, ctx.preferences);

        // The eligible recipients and the total DEBIT (buildDividendRecipients), then the validations
        let recipients = await this.buildDividendRecipients(data, ctx.holders, ctx.dividendTokenInfo, dividend);
        error = await this.validateDividend(data, ctx.tokenInfo, ctx.dividendTokenInfo, error);

        // Price the per-tx FEE (priceDividend), then take the DEBIT out of balances (stageDividendDebit)
        await this.priceDividend(recipients, fees, data);
        error = this.stageDividendDebit(dividend, ctx, error);

        // The controller guard on the aggregate distribution, then the fee payment
        let guardFee;
        ({ error, guardFee } = await this.runDividendGuard(data, dividend, ctx, error));
        error = await this.validateDividendFeePayment(data, fees, ctx.balances, error);

        // Adjust balances to reduce by FEE AMOUNT (only for XCHAIN deduction mode)
        if(!error && (!fees['PAYMENT_MODE'] || fees['PAYMENT_MODE'] === 2))
            ctx.balances = this.util.debitBalances(ctx.balances, fees['TICK_ID'], fees['AMOUNT']);

        // Final status, the DIVIDEND record, the ledger rows and the mappings (settleDividend)
        await this.settleDividend(data, dividend, fees, recipients, ctx, error, guardFee);
    }

    // The reads every later step shares: SOURCE balances and preferences, the TICK holders, and
    // token info for TICK, DIVIDEND_TICK and the GAS token
    async loadDividendContext(data){
        // Get source address balances and preferences, as well as TICK holders list
        let balances    = await this.indexerDb.getAddressBalances(data['SOURCE'], null, data['BLOCK_INDEX'], data['ACTION_INDEX']);
        let preferences = await this.indexerDb.getAddressPreferences(data['SOURCE'], data['BLOCK_INDEX'], data['ACTION_INDEX']);
        let holders     = await this.indexerDb.getHolders(data['TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX']);

        // Get token information on TICK and DIVIDEND_TICK
        let tokenInfo         = await this.indexerDb.getTokenInfo(data['TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX']);
        let dividendTokenInfo = await this.indexerDb.getTokenInfo(data['DIVIDEND_TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX']);

        // Controller-bound token gas context. If DIVIDEND_TICK's `transfer` class is bound to a
        // controller, the aggregate outbound distribution runs that contract's `guard` before
        // settling and SOURCE pays the (bounded) guard gas in GAS. Guard fee is reserved out of
        // `balances` before the per-tx fee check so the two GAS charges are cumulative. Pre-flag-day
        // the guard is a strict no-op.
        let gasTick = this.config['GAS'];
        let gasInfo = await this.indexerDb.getTokenInfo(gasTick, data['BLOCK_INDEX'], data['ACTION_INDEX']);

        return { balances, preferences, holders, tokenInfo, dividendTokenInfo, gasTick, gasInfo };
    }

    // The holders that receive this DIVIDEND and each one's share, with the total DEBIT set on the
    // dividend record. Returns recipients as { address: amount }.
    async buildDividendRecipients(data, holders, dividendTokenInfo, dividend){
        // List of recipients which will receive this DIVIDEND
        // Format: recipients['address'] = amount;
        let recipients = {};

        // List of addresses allowed or blocked from holding DIVIDEND_TICK
        // Held as Sets: the holder loop below probes membership once per holder, so an O(1)
        // hash probe replaces a scan of the whole list. Emptiness still gates the check, so a
        // configured-but-empty ALLOW_LIST keeps admitting everyone exactly as before.
        let allowList = (dividendTokenInfo && dividendTokenInfo['ALLOW_LIST']) ? new Set(await this.indexerDb.getList(dividendTokenInfo['ALLOW_LIST'], data['BLOCK_INDEX'])) : new Set();
        let blockList = (dividendTokenInfo && dividendTokenInfo['BLOCK_LIST']) ? new Set(await this.indexerDb.getList(dividendTokenInfo['BLOCK_LIST'], data['BLOCK_INDEX'])) : new Set();

        // Loop through list of holders and build out valid recipients list
        dividend['DEBIT'] = 0;
        if(dividendTokenInfo){
            for(let address in holders){
                let valid = true;
                // Check if recipient is on the allow or block lists and only add valid addresses to the recipients list
                if((allowList.size && !allowList.has(address)) || (blockList.size && blockList.has(address)))
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
        return recipients;
    }
}

// Install the phase methods from dividend/ NON-ENUMERABLE, the shape the class body they came
// from produced: parse() reaches them as this.<method>, suites can stub them through
// Dividend.prototype, and for-in over a handler stays empty. Same install as dispenser_close.js
// and db/index.js use.
for(const part of [validatePart, feesPart, controllerGuardPart, settlePart]){
    const descriptors = Object.getOwnPropertyDescriptors(part);
    for(const key of Reflect.ownKeys(descriptors)) descriptors[key].enumerable = false;
    Object.defineProperties(Dividend.prototype, descriptors);
}

module.exports = Dividend;