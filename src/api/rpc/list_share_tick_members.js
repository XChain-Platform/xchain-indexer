/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
    parseTickCoinItem,
} = require('../../consensus/list_tick_coin.js');

function byteOrder(left, right){
    return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

async function qualifyTickMembers(db, members, coin, coins){
    let qualified = [];
    for(let item of members){
        if(parseTickCoinItem(item, coins) !== null){
            qualified.push(item);
            continue;
        }

        let nameForm = coin + LIST_TICK_COIN_SEPARATOR + item;
        if(nameForm.length <= LIST_TICK_COIN_MAX_ITEM_LENGTH){
            qualified.push(nameForm);
            continue;
        }

        let id = await db.getTickerId(item);
        qualified.push(coin + LIST_TICK_COIN_SEPARATOR + '^' + id);
    }
    return Array.from(new Set(qualified)).sort(byteOrder);
}

module.exports = { qualifyTickMembers };
