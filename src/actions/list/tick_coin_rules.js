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
    parseTickCoinItem,
    isTickCoinRestWellFormed,
} = require('../../consensus/list_tick_coin.js');

function isBridgeMirrorLeg(data, config){
    if(!data || !data['IS_GENESIS'] || !config || !Array.isArray(config['COINS']) ||
        !config['ADDRESS'] || data['SOURCE'] === undefined || data['SOURCE'] === null)
        return false;

    return config['COINS'].some((coin) => {
        if(typeof coin !== 'string') return false;
        let key = 'BRIDGE_' + coin;
        let address = config['ADDRESS'][key];
        return address !== undefined && address !== null && data['SOURCE'] === address;
    });
}

function classifyTickItem(item, { coin, coins, config, mirrorLeg }){
    let parsed = parseTickCoinItem(item, coins);
    if(parsed === null)
        return { path: 'lookup', item };

    if(mirrorLeg)
        return { path: 'valid', item: parsed.canonical };

    if(!isTickCoinRestWellFormed(parsed.rest, parsed.canonical, config))
        return { path: 'format', item };

    let ownCoin = typeof coin === 'string' ? coin.toUpperCase() : null;
    if(parsed.coin === ownCoin)
        return { path: 'lookup', item: parsed.rest };

    return { path: 'valid', item: parsed.canonical };
}

module.exports = {
    isBridgeMirrorLeg,
    classifyTickItem,
};
