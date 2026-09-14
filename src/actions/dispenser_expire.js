const { getLogger } = require('../observability/index.js');
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
 * XChain Platform Action - DISPENSER_EXPIRE
 * 
 * This action processes dispensers that have expired
 *
 ********************************************************************/

// The settlement phase, installed onto Dispenser_Expire.prototype below
const settlePart = require('./dispenser_expire/settle.js');

class Dispenser_Expire {

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

    // Handle expiring a dispenser
    async parse(params, data, error){

        // Get info on the dispenser. BLOCK_TIME is threaded through to
        // getDispenserEdits' ALLOW_LIST / BLOCK_LIST activation compare; omitted it
        // coerced to 0 and the compare silently read false, leaving this path with the
        // list overlay never applied. Behavior-neutral today (nothing below reads those
        // two fields) and set on every dispatch (utility.js processExpirations); see the
        // fuller note in dispenser_close.js.
        let dispenser = await this.indexerDb.getDispenserInfo(this.config['COIN'], data['ACTION_INDEX'], data['BLOCK_TIME']);

        // Only proceed if we have a valid dispenser
        if(dispenser){

            // Add SOURCE and GET_ADDRESS addresses and GET_TICK to addresses list
            this.util.addAddressTicker(dispenser['SOURCE'],      dispenser['GIVE_TICK']);
            this.util.addAddressTicker(dispenser['GET_ADDRESS'], dispenser['GIVE_TICK']);

            // Define DISPENSER_EXPIRE action
            let action = {}
            action['ACTION']      = 'DISPENSER_EXPIRE';
            action['BLOCK_INDEX'] = data['BLOCK_INDEX'];

            // Create a record of this DISPENSER_EXPIRE action in the actions table
            data['ACTION_INDEX'] = await this.indexerDb.createActionIndex(action);

            // Set the status to valid
            data['STATUS'] = 'valid';

            // Print status message
            getLogger().info("\t DISPENSER_EXPIRE : " + this.config['COIN'] + ':' + dispenser['ACTION_INDEX'] + ' : ' + data['STATUS']);

            // Release or refund the escrow, record the expiry and post the ledger changes
            // (dispenser_expire/settle.js)
            await this.settleExpiry(data, dispenser);
        }
    }
}

// Install the phase methods from dispenser_expire/ NON-ENUMERABLE, the shape the class body
// they came from produced: parse() reaches them as this.<method>, suites can stub them
// through Dispenser_Expire.prototype, and for-in over a handler stays empty. Same install
// as db/index.js uses for its query mixins.
for(const part of [settlePart]){
    const descriptors = Object.getOwnPropertyDescriptors(part);
    for(const key of Reflect.ownKeys(descriptors)) descriptors[key].enumerable = false;
    Object.defineProperties(Dispenser_Expire.prototype, descriptors);
}

module.exports = Dispenser_Expire;