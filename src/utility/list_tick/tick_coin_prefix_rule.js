// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const { coinQualifierRoot } = require('../../consensus/list_tick_coin.js');

const TICK_COIN_PREFIX_REFUSAL = 'invalid: TICK (reserved)';

function tickCoinPrefixNeedsProbe({ tick, isGenesis, isTopLevel, coins }){
    if(isGenesis || isTopLevel !== true) return false;

    let text = String(tick);
    return !text.startsWith('^') && coinQualifierRoot(text, coins) !== null;
}

module.exports = {
    TICK_COIN_PREFIX_REFUSAL,
    tickCoinPrefixNeedsProbe,
};
