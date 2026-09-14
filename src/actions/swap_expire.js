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
 * XChain Platform Action - SWAP_EXPIRE
 *
 * This action processes swaps that have expired
 *
 ********************************************************************/

// The settlement phase, installed onto Swap_Expire.prototype below
const settlePart = require('./swap_expire/settle.js');

class Swap_Expire {

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

    // Handle expiring a swap
    async parse(params, data, error){

        // Get info on the swap by action_index. Pass null coin (not the local COIN) so a
        // cross-chain swap (get_coin = counterparty chain) is also located on expiry.
        let swapInfo = await this.indexerDb.getSwapInfo(null, data['ACTION_INDEX']);

        // Bail out if swap no longer exists (already expired or rolled back)
        if(!swapInfo)
            return;

        // Add SOURCE address and GIVE_TICK to addresses list
        this.util.addAddressTicker(swapInfo['SOURCE'], swapInfo['GIVE_TICK']);

        // Define SWAP_EXPIRE action
        let action = {}
        action['ACTION']      = 'SWAP_EXPIRE';
        action['BLOCK_INDEX'] = data['BLOCK_INDEX'];

        // Create a record of this SWAP_EXPIRE action in the actions table
        data['ACTION_INDEX'] = await this.indexerDb.createActionIndex(action);

        // Set the status to valid
        data['STATUS'] = 'valid';

        // Print status message
        getLogger().info("\t SWAP_EXPIRE : " + this.config['COIN'] + ':' + swapInfo['ACTION_INDEX'] + ' : ' + data['STATUS']);

        // Refund the escrow, record the expiry and post the ledger changes (swap_expire/settle.js)
        await this.settleExpiry(data, swapInfo);
    }
}

// Install the phase methods from swap_expire/ NON-ENUMERABLE, the shape the class body they
// came from produced: parse() reaches them as this.<method>, suites can stub them through
// Swap_Expire.prototype, and for-in over a handler stays empty. Same install as db/index.js
// uses for its query mixins.
for(const part of [settlePart]){
    const descriptors = Object.getOwnPropertyDescriptors(part);
    for(const key of Reflect.ownKeys(descriptors)) descriptors[key].enumerable = false;
    Object.defineProperties(Swap_Expire.prototype, descriptors);
}

module.exports = Swap_Expire;
