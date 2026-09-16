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

// WHERE THE PARTS LIVE. This file is the entry and the per-leg dispatch. The legs and
// their consolidation are in ./legs.js, the per-leg verdict ladder in ./validate.js,
// the GAS context and controller guard in ./controller_guard.js, and the rows and
// ledger write in ./settle.js. Every part runs with `this` bound to the handler.
const legs            = require('./legs.js');
const validate        = require('./validate.js');
const controllerGuard = require('./controller_guard.js');
const settle          = require('./settle.js');

// One leg of the consolidated DESTROY: its fields copied onto the shared data row, the
// TICK, FORMAT and General validations, the controller guard, and the leg's record.
// Runs with `this` bound to the handler. The running SOURCE balances live on ctx so a
// later leg is judged against what an earlier one already burned.
async function processLeg(ctx, idx){
    // Parse in the destroy information
    let info = ctx.destroys[idx];

    // Reset error to the original value
    let error = ctx.origError;

    // Copy base transaction data object
    let destroy = ctx.data;

    // Update transaction data object with destroy values
    destroy['TICK']   = info[0];
    destroy['AMOUNT'] = info[1];
    destroy['MEMO']   = info[2];

    // Convert NUMBER fields from string value to number value so comparisons are mathematical
    if(!error)
        destroy = this.util.setNumberFormats(destroy);

    // Get information on token
    let tokenInfo = ctx.ticks[destroy['TICK']];

    error = validate.validateLegTick.call(this, destroy, tokenInfo, error);
    error = await validate.validateLegRules.call(this, destroy, tokenInfo, ctx.balances, ctx.data, error);

    let guard = await controllerGuard.runLegGuard.call(this, destroy, tokenInfo, idx, ctx.gas, error);
    error = guard.error;

    // Adjust balances to reduce by DESTROY AMOUNT
    if(!error)
        ctx.balances = this.util.debitBalances(ctx.balances, tokenInfo['TICK_ID'], destroy['AMOUNT']);

    await settle.recordLeg.call(this, ctx.data, destroy, error, guard.guardFee, ctx.gas, ctx.debits);
}

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
        // Example payloads by FORMAT version:
        // let str = '0|BRRR|1|foo';
        // let str = '1|BRRR|1|GAS|10|bar';
        // let str = '2|BRRR|1|foo|GAS|10|bar';
        // params = String(str).split('|');
        // data['FORMAT'] = this.util.getFormatVersion(params[0]);

        // Validate that format is known
        let format = data['FORMAT'];
        if(!error && (format===null || this.formats[format] === undefined ))
            error = 'invalid: VERSION (unknown)';

        // The legs this DESTROY names, the token row for each tick, then the merge of legs
        // sharing a TICK and MEMO
        let destroys = legs.buildDestroys(params, format, error);
        let ticks    = await legs.loadTicks.call(this, destroys, data);
        destroys     = legs.consolidateLegs.call(this, destroys, ticks, data);

        // Get source address balances
        let balances = await this.indexerDb.getAddressBalances(data['SOURCE'], null, data['BLOCK_INDEX'], data['ACTION_INDEX']);

        // GAS context for controller-bound legs, loaded once for the whole action
        let gas = await controllerGuard.loadGasContext.call(this, data);

        // Store original error value, and the arrays of credits and debits
        let ctx = { data, destroys, ticks, balances, gas, origError: error, credits: [], debits: [] };

        // Loop through destroys and process each
        for(let idx in destroys)
            await processLeg.call(this, ctx, idx);

        // Write the ledger changes and refresh balances and supply
        await settle.settleLedger.call(this, data, ctx.credits, ctx.debits);

        // Create action mappings
        await this.mapper.createMappings(data);
    }
}

module.exports = Destroy;