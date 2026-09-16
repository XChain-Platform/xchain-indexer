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

// The handler's phases, grouped by concern and installed onto Airdrop.prototype below:
// legs.js reads the wire into legs, validate.js judges a leg, its LIST and its SOURCE,
// recipients.js expands and filters who receives it, fees.js prices the fee and validates
// its payment, controller_guard.js runs the bound guard, settle.js stages, commits, records
// and closes
const legsPart            = require('./legs.js');
const validatePart        = require('./validate.js');
const recipientsPart      = require('./recipients.js');
const feesPart            = require('./fees.js');
const controllerGuardPart = require('./controller_guard.js');
const settlePart          = require('./settle.js');

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

        this.formats = {};
        this.formats[0] = 'VERSION|TICK|AMOUNT|LIST_ACTION_INDEX|MEMO';
        this.formats[1] = 'VERSION|LIST_ACTION_INDEX|TICK|AMOUNT|TICK|AMOUNT|MEMO';
        this.formats[2] = 'VERSION|TICK|AMOUNT|LIST_ACTION_INDEX|TICK|AMOUNT|LIST_ACTION_INDEX|MEMO';
        this.formats[3] = 'VERSION|TICK|AMOUNT|LIST_ACTION_INDEX|MEMO|TICK|AMOUNT|LIST_ACTION_INDEX|MEMO';

        // 1=Tick list, 2=Address list.
        this.listTypes = [1,2];
    }

    // Handle parsing the AIRDROP transaction
    async parse(params, data, error){
        /*****************************************************************
         * DEBUGGING - Force params
         ****************************************************************/
        // Example payloads by FORMAT version:
        // Single Airdrop
        // let str = '0|AIRDROPTEST1|1|1257|test'; // ADDRESS LIST
        // let str = '0|AIRDROPTEST2|1|1191|test'; // TICK LIST
        // Multi-Airdrop (brief)
        // let str = '1|1257|AIRDROPTEST1|1|AIRDROPTEST2|2|test brief';
        // Multi-Airdrop (Full)
        // let str = '2|AIRDROPTEST1|1|1257|AIRDROPTEST2|2|1191|test full';
        // Multi-Airdrop (Full) w multiple memos
        // let str = '3|AIRDROPTEST1|1|1257|memo1|AIRDROPTEST2|2|1191|memo2';
        // params = String(str).split('|');
        // data['FORMAT'] = this.util.getFormatVersion(params[0]);

        // Validate that format is known
        let format = data['FORMAT'];
        if(!error && (format===null || this.formats[format] === undefined ))
            error = 'invalid: VERSION (unknown)';

        // One leg per wire group, and the token info of every TICK they name (airdrop/legs.js)
        let airdrops = this.readAirdropLegs(params, format);
        let ticks    = await this.fetchAirdropTicks(airdrops, data);

        // Get source address balances and preferences
        let balances    = await this.indexerDb.getAddressBalances(data['SOURCE'], null, data['BLOCK_INDEX'], data['ACTION_INDEX']);
        let preferences = await this.indexerDb.getAddressPreferences(data['SOURCE'], data['BLOCK_INDEX'], data['ACTION_INDEX']);

        // Load gas token info once before the loop: a controller-bound TICK's guard bills SOURCE
        // metered gas in GAS, reserved against `balances` so a denied/cheap guard can't drive GAS negative.
        let gasTick = this.config['GAS'];
        let gasInfo = await this.indexerDb.getTokenInfo(gasTick, data['BLOCK_INDEX'], data['ACTION_INDEX']);

        // Create the fees object
        let fees = await this.util.createFeesObject(this.indexerDb, data, preferences);

        // Store original error value
        // Array of credits and debits
        let ctx = { ticks, balances, gasTick, gasInfo, fees, origError: error, credits: [], debits: [] };

        // Loop through airdrops and process each
        for(let idx in airdrops){
            // Parse in the airdrop information
            let info = airdrops[idx];
            data = await this.processAirdropLeg(idx, info, data, ctx);
        }

        // Ledger, balances, supply and mappings (airdrop/settle.js)
        await this.finishAirdrop(data, ctx);
    }

    // Judge and settle one airdrop leg. Every leg validates against the action's original error.
    // `data` is returned because the NUMBER-format pass may replace it, and the next leg and the
    // close of the action read the replaced object.
    async processAirdropLeg(idx, info, data, ctx){
        let error = ctx.origError; // each leg validates independently against the original error state

        // Reset error to the original value

        // Copy base transaction data object
        let airdrop = data;

        // Update transaction data object with airdrop values
        airdrop['TICK']              = info[0];
        airdrop['AMOUNT']            = info[1];
        airdrop['LIST_ACTION_INDEX'] = info[2];
        airdrop['MEMO']              = info[3];

        // Get information on token
        let tokenInfo = ctx.ticks[airdrop['TICK']];

        // Convert NUMBER fields from string to number so comparisons below are mathematical, not lexical.
        if(!error)
            data = this.util.setNumberFormats(data);

        // TICK, FORMAT, general and LIST validations (airdrop/validate.js)
        let leg = await this.validateAirdropLeg(airdrop, tokenInfo, data, error);
        error = leg.error;

        // Who the LIST reaches (airdrop/recipients.js), then the SOURCE checks (airdrop/validate.js)
        let recipients = await this.expandAirdropRecipients(leg.type, leg.list, data, error);
        error = await this.validateAirdropSource(airdrop, tokenInfo, ctx, error);

        // Update recipients list to only do airdrops to addresses which allow it
        recipients = await this.approveAirdropRecipients(recipients, tokenInfo, data);

        // Determine total DEBIT
        airdrop['DEBIT'] = (!error) ? this.util.bcmul(recipients.size, airdrop['AMOUNT'], tokenInfo['DECIMALS']) : 0;

        // Price the per-tx FEE (airdrop/fees.js), then stage the DEBIT (airdrop/settle.js)
        await this.priceAirdropLeg(recipients, ctx.fees, data);
        let staged = this.stageAirdropLeg(airdrop, tokenInfo, ctx, error);

        // Controller guard on the aggregate outbound move (airdrop/controller_guard.js)
        let guard = await this.runAirdropGuard(idx, airdrop, tokenInfo, data, ctx, staged.legBalances, staged.error);
        error = guard.error;

        // Fee payment (airdrop/fees.js), then the fee debit and the commit (airdrop/settle.js)
        error = await this.validateAirdropFeePayment(data, ctx.fees, guard.legBalances, error);
        this.commitAirdropLeg(ctx.fees, guard.legBalances, ctx, error);

        // Final status, the AIRDROP record and the staged ledger rows (airdrop/settle.js)
        await this.settleAirdropLeg(airdrop, data, ctx, error, recipients, guard.guardFee);
        return data;
    }
}

// Install the phase methods from airdrop/ NON-ENUMERABLE, the shape the class body they came
// from produced: parse() reaches them as this.<method>, suites can stub them through
// Airdrop.prototype, and for-in over a handler stays empty. Same install as dispenser_close.js
// and db/index.js use.
for(const part of [legsPart, validatePart, recipientsPart, feesPart, controllerGuardPart, settlePart]){
    const descriptors = Object.getOwnPropertyDescriptors(part);
    for(const key of Reflect.ownKeys(descriptors)) descriptors[key].enumerable = false;
    Object.defineProperties(Airdrop.prototype, descriptors);
}

module.exports = Airdrop;