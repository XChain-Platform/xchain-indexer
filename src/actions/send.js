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

// The handler's phases, grouped by concern and installed onto Send.prototype below: legs.js
// reads the wire into legs and consolidates them, prefetch.js makes the once-per-action
// reads, validate.js and gated_handoff.js judge a leg, controller_guard.js runs the bound
// guards, settle.js records each leg and closes the action
const legsPart            = require('./send/legs.js');
const prefetchPart        = require('./send/prefetch.js');
const validatePart        = require('./send/validate.js');
const gatedHandoffPart    = require('./send/gated_handoff.js');
const controllerGuardPart = require('./send/controller_guard.js');
const settlePart          = require('./send/settle.js');

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

        this.formats = {};
        this.formats[0] = 'VERSION|TICK|AMOUNT|DESTINATION|MEMO';
        this.formats[1] = 'VERSION|TICK|AMOUNT|DESTINATION|AMOUNT|DESTINATION|MEMO';
        this.formats[2] = 'VERSION|TICK|AMOUNT|DESTINATION|TICK|AMOUNT|DESTINATION|MEMO';
        this.formats[3] = 'VERSION|TICK|AMOUNT|DESTINATION|MEMO|TICK|AMOUNT|DESTINATION|MEMO';
    }

    // Handle parsing the SEND transaction
    async parse(params, data, error){
        // Read the wire into legs (send/legs.js)
        let sends;
        ({ error, sends } = this.readSendLegs(params, data, error));

        // Token info, preferences and gated packs, once per distinct key (send/prefetch.js)
        let ctx = await this.prefetchSendContext(sends, data);

        // Consolidate sends by DESTINATION and TICK (send/legs.js)
        sends = this.consolidateSendLegs(sends, ctx.ticks, data);

        // Destination balances for the gated-file handoff rule, then the SOURCE-side context
        // every leg shares (send/prefetch.js)
        ctx.destBalances = await this.loadDestinationBalances(sends, ctx.gatedPacks, data);
        Object.assign(ctx, await this.loadSourceContext(data));

        // Store original error value
        ctx.origError = error;

        // Array of credits and debits
        ctx.credits = [];
        ctx.debits  = [];

        // Loop through sends and process each
        for(let idx in sends){

            // Parse in the send information
            let info = sends[idx];

            await this.processSendLeg(idx, info, data, ctx);
        }

        // Ledger, balances, supply, mappings and dispenser triggers (send/settle.js)
        await this.finishSend(data, ctx);
    }

    // Judge and settle one consolidated leg. Every leg restarts from the action's original
    // error, and the balances on ctx are what the next leg is measured against.
    async processSendLeg(idx, info, data, ctx){

        // Reset error to the original value (per-leg validation restarts from origError)
        let error = ctx.origError;

        // `send` aliases `data`: mutating it below also mutates the shared transaction
        // object, which the multi-leg loop relies on for each leg's downstream calls.
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
        let tokenInfo = ctx.ticks[send['TICK']];

        // TICK, FORMAT and general validations (send/validate.js)
        error = await this.validateSendLeg(send, tokenInfo, data, ctx, error);

        // Gated-content rule: the key handoff MESSAGE (send/gated_handoff.js)
        error = await this.checkGatedHandoff(send, tokenInfo, data, ctx, error);

        // The token's controller guard, then the SOURCE-side and recipient-side address guards
        // (send/controller_guard.js)
        let guard = await this.runSendGuards(idx, send, tokenInfo, ctx, error);

        // Debit, final status, the SEND record and the staged ledger rows (send/settle.js)
        await this.settleSendLeg(send, tokenInfo, data, ctx, guard.error, guard);
    }
}

// Install the phase methods from send/ NON-ENUMERABLE, the shape the class body they came
// from produced: parse() reaches them as this.<method>, suites can stub them through
// Send.prototype, and for-in over a handler stays empty. Same install as dispenser_close.js
// and db/index.js use.
for(const part of [legsPart, prefetchPart, validatePart, gatedHandoffPart, controllerGuardPart, settlePart]){
    const descriptors = Object.getOwnPropertyDescriptors(part);
    for(const key of Reflect.ownKeys(descriptors)) descriptors[key].enumerable = false;
    Object.defineProperties(Send.prototype, descriptors);
}

module.exports = Send;
