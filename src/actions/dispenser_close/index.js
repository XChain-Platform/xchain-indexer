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
 * XChain Platform Action - DISPENSER_CLOSE
 *
 * This action processes dispensers that need to be closed
 *
 ********************************************************************/

const divergenceMetrics = require('../../chain/dispenser_divergence_metrics.js');

// The handler's phases, grouped by concern and installed onto Dispenser_Close.prototype below:
// close.js decides where the escrow goes, settle.js moves it and records the close
const closePart  = require('./close.js');
const settlePart = require('./settle.js');

const { getLogger } = require('../../observability/index.js');
class Dispenser_Close {

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

    // Handle closing a dispenser
    async parse(params, data, error){

        // Get info on the dispenser.
        //
        // BLOCK_TIME is the third argument on purpose: getDispenserInfo threads it into
        // getDispenserEdits, whose ALLOW_LIST / BLOCK_LIST activation compare is
        // bcgt(block_time, edit.block_time + DISPENSER_LIST_DELAY). Omitted, it coerced
        // to 0 (bcnum) and that compare silently read false, so this path alone held a
        // dispenser object with the list overlay never applied. Behavior-neutral today
        // (nothing below reads ALLOW_LIST or BLOCK_LIST, and EXPIRATION overlays
        // unconditionally; GIVE_ESCROW never overlays and stays the create-time value,
        // with refills counted by getDispenserAmountRemaining/GIVE_REMAINING instead);
        // passed so the object matches what dispense.js and
        // dispenser.js get, and so a future reader of the list fields here is not handed
        // a stale view by a NaN-as-zero compare. Every dispatch path sets BLOCK_TIME
        // (utility.js processCancellations, both dispense.js auto-closes).
        let dispenser = await this.indexerDb.getDispenserInfo(this.config['COIN'], data['DISPENSER_ACTION_INDEX'], data['BLOCK_TIME']);

        // Only proceed if we have a valid dispenser
        if(dispenser){


            // Define DISPENSER_CLOSE action
            let action = {}
            action['ACTION']      = 'DISPENSER_CLOSE';
            action['TX_INDEX']    = data['TX_INDEX'];
            action['BLOCK_INDEX'] = data['BLOCK_INDEX'];

            // Create a record of this DISPENSER_CLOSE action in the actions table
            data['ACTION_INDEX'] = await this.indexerDb.createActionIndex(action);

            // Set the status to valid
            data['STATUS'] = 'valid';

            // Print status message
            getLogger().info("\t DISPENSER_CLOSE : " + this.config['COIN'] + ':' + dispenser['ACTION_INDEX'] + ' : ' + data['STATUS']);

            // Observability: a close carrying DISPENSER_STATUS='cancelled' is a
            // cancel (DISPENSER format 1) taking effect. Count it so the volume of
            // cancels the upstream decoder does not mirror can be sized from logs.
            // Measurement only - no state change.
            if(data['DISPENSER_STATUS'] === 'cancelled')
                divergenceMetrics.recordCancel(this.config['COIN'], data['BLOCK_INDEX'], dispenser['ACTION_INDEX'], dispenser['GET_ADDRESS']);

            // Hand the escrow to its destination, record the close and post the ledger
            // changes (dispenser_close/settle.js)
            await this.settleClose(data, dispenser);
        }
    }
}

// Install the phase methods from dispenser_close/ NON-ENUMERABLE, the shape the class body
// they came from produced: parse() reaches them as this.<method>, suites can stub them
// through Dispenser_Close.prototype, and for-in over a handler stays empty. Same install
// as db/index.js uses for its query mixins.
for(const part of [closePart, settlePart]){
    const descriptors = Object.getOwnPropertyDescriptors(part);
    for(const key of Reflect.ownKeys(descriptors)) descriptors[key].enumerable = false;
    Object.defineProperties(Dispenser_Close.prototype, descriptors);
}

module.exports = Dispenser_Close;
