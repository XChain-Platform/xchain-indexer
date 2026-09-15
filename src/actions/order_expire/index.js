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
 * XChain Platform Action - ORDER_EXPIRE
 * 
 * This action processes orders that have expired
 *
 ********************************************************************/

// The settlement phase, installed onto Order_Expire.prototype below
const settlePart = require('./settle.js');

class Order_Expire {

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

    // Handle expiring a order
    async parse(params, data, error){

        // Get info on the order by action_index. Pass null coin (not the local COIN) so a
        // cross-chain order (get_coin = counterparty chain) is also located on expiry.
        let orderInfo = await this.indexerDb.getOrderInfo(null, data['ACTION_INDEX']);

        // Bail out if order no longer exists (already expired or rolled back)
        if(!orderInfo)
            return;

        // Add SOURCE address and GIVE_TICK to addresses list
        this.util.addAddressTicker(orderInfo['SOURCE'], orderInfo['GIVE_TICK']);

        // Define ORDER_EXPIRE action
        let action = {}
        action['ACTION']      = 'ORDER_EXPIRE';
        action['BLOCK_INDEX'] = data['BLOCK_INDEX'];

        // Create a record of this ORDER_EXPIRE action in the actions table
        data['ACTION_INDEX'] = await this.indexerDb.createActionIndex(action);

        // Set the status to valid
        data['STATUS'] = 'valid';

        // Print status message
        getLogger().info("\t ORDER_EXPIRE : " + this.config['COIN'] + ':' + orderInfo['ACTION_INDEX'] + ' : ' + data['STATUS']);

        // Expire the order (or park it as 'expiring' behind pending COINPay obligations)
        // and post the ledger changes (order_expire/settle.js)
        await this.settleExpiry(data, orderInfo);
    }
}

// Install the phase methods from order_expire/ NON-ENUMERABLE, the shape the class body they
// came from produced: parse() reaches them as this.<method>, suites can stub them through
// Order_Expire.prototype, and for-in over a handler stays empty. Same install as db/index.js
// uses for its query mixins.
for(const part of [settlePart]){
    const descriptors = Object.getOwnPropertyDescriptors(part);
    for(const key of Reflect.ownKeys(descriptors)) descriptors[key].enumerable = false;
    Object.defineProperties(Order_Expire.prototype, descriptors);
}

module.exports = Order_Expire;