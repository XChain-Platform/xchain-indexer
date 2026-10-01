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
 * XChain Platform - AIRDROP ticker-list holder collection.
 *
 ********************************************************************/

'use strict';

const { ownCoinTickItems } = require('../../consensus/list_tick_coin.js');

async function collectTickHolders(items, options){
    if(!Array.isArray(items))
        throw new TypeError('items must be an array');
    if(!options || typeof options.getHolders !== 'function')
        throw new TypeError('getHolders must be a function');
    if(options.active === true && typeof options.getTickerId !== 'function')
        throw new TypeError('getTickerId must be a function when active');

    let recipients = new Set();

    if(options.active !== true){
        for(let item of items){
            let holders = await options.getHolders(item);
            for(let address in holders)
                recipients.add(address);
        }
        return recipients;
    }

    for(let entry of ownCoinTickItems(items, options.coin, options.coins)){
        if(entry.qualified){
            let tickerId = await options.getTickerId(entry.rest);
            if(tickerId === null || tickerId === undefined)
                continue;
        }

        let holders = await options.getHolders(entry.rest);
        for(let address in holders)
            recipients.add(address);
    }

    return recipients;
}

module.exports = { collectTickHolders };
