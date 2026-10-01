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
 ********************************************************************/

'use strict';

const {
    LIST_TICK_COIN_SEPARATOR,
    LIST_TICK_COIN_MAX_ITEM_LENGTH,
    parseTickCoinItem
} = require('../../consensus/list_tick_coin.js');

async function qualifyTickMembers(db, members, coin, coins){
    if(!Array.isArray(members))
        throw new TypeError('members must be an array');

    let qualified = [];
    for(let item of members){
        if(parseTickCoinItem(item, coins) !== null){
            qualified.push(item);
            continue;
        }

        let name = coin + LIST_TICK_COIN_SEPARATOR + item;
        if(name.length <= LIST_TICK_COIN_MAX_ITEM_LENGTH){
            qualified.push(name);
            continue;
        }

        let tickId = await db.getTickerId(item);
        if(tickId === null)
            throw new Error('shared list ticker is missing from index_tickers');
        qualified.push(coin + LIST_TICK_COIN_SEPARATOR + '^' + tickId);
    }

    return [...new Set(qualified)].sort((left, right) =>
        Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
    );
}

module.exports = { qualifyTickMembers };
