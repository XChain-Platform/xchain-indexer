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
 * XChain Platform Action - DISPENSE
 * 
 * This action dispenses tokens from dispensers when they are triggered
  *
 ********************************************************************/

// This handler's two passes live in dispense/, installed onto Dispense.prototype below:
// context.js builds the ctx both passes thread, pricing.js is the per-dispenser loop
// body and settle.js the per-dispense one. parse() runs them in the same order and the
// same loops it always did.
//
// The caps activation is required HERE and reached through isDispenseCapsActive below,
// rather than required in settle.js: bin/check-flagday-deploy.sh greps the deployed
// src/actions/dispense.js for the literal dispenser_caps_activation, and an absent
// marker there reads UNKNOWN rather than failing, so moving the require would retire
// that flag-day row silently.
const dispenserCaps = require('../dispenser_caps_activation.js');

const contextPart = require('./dispense/context.js');
const pricingPart = require('./dispense/pricing.js');
const pricingPathsPart = require('./dispense/pricing_paths.js');
const settlePart = require('./dispense/settle.js');
class Dispense {

    // Handle constructing a class instance
    constructor(action){
        // Setup short aliases
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;
    }

    // Handle parsing the DISPENSE transaction
    async parse(params, data, error){

        // Every local the two passes share, built by dispense/context.js: the block
        // fields, the matching dispensers, the settlement-value tally and its scale.
        let ctx = await this.prepareDispenseContext(data);

        // Loop through dispensers and generate a list of valid DISPENSE actions
        // Note: Dispense transactions which do not match an valid dispenser are ignored
        for(let action_index of ctx.action_indexes)
            await this.priceDispenseForDispenser(ctx, action_index);

        // Flag-day gate: at/above the activation the auto-close threshold is the
        // dispenser's PER-UNIT price; below it the legacy aggregate-purchase
        // comparison applies so historical replay stays byte-identical.
        ctx.perUnitClose = await this.actions.protocolChanges.isEnabled('DISPENSER_CLOSE_PER_UNIT', ctx.block_index);

        // Loop through dispenses and process each
        for(let idx in ctx.dispenses)
            await this.settleDispense(ctx, idx);
    }

    // The dispenser-caps flag-day, read through the handler so the activation require,
    // and therefore the literal bin/check-flagday-deploy.sh greps this file for, stays
    // in this file while the auto-close that consumes it lives in dispense/settle.js.
    isDispenseCapsActive(block_time){
        return dispenserCaps.isDispenserCapsActive(block_time, this.config['NETWORK']);
    }
}

// Install the pass methods from dispense/ NON-ENUMERABLE, the shape the class body they
// came from produced: parse() reaches them as this.<method>, suites can stub them through
// Dispense.prototype, and for-in over a handler stays empty. Same install as
// dispenser_close.js and db/index.js use.
for(const part of [contextPart, pricingPart, pricingPathsPart, settlePart]){
    const descriptors = Object.getOwnPropertyDescriptors(part);
    for(const key of Reflect.ownKeys(descriptors)) descriptors[key].enumerable = false;
    Object.defineProperties(Dispense.prototype, descriptors);
}

module.exports = Dispense;
