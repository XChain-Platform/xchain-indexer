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
 * XChain Platform Action - ISSUE coin-qualified ticker reservation.
 *
 ********************************************************************/

'use strict';

const gateRegistry = require('../../consensus/gate_registry');
const {
    TICK_COIN_PREFIX_REFUSAL,
    tickCoinPrefixNeedsProbe,
} = require('../../utility/list_tick/tick_coin_prefix_rule.js');

const LIST_TICK_COIN_GATE = 'list_tick_coin_activation.LIST_TICK_COIN_ACTIVATION';

async function validateTickCoinPrefix(ctx){
    let { data } = ctx;

    if(ctx.error || !gateRegistry.activeAt(LIST_TICK_COIN_GATE, this.config['NETWORK'], this.config['COIN'], data['BLOCK_INDEX'], null))
        return;

    if(!tickCoinPrefixNeedsProbe({
        tick: data['TICK'],
        isGenesis: data['IS_GENESIS'],
        isTopLevel: this.isTopLevelIssuance(data['TICK']),
        coins: this.config['COINS'],
    }))
        return;

    let existing = await this.resolveOnlyGetTokenInfo(data['TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX']);
    if(!existing)
        ctx.error = TICK_COIN_PREFIX_REFUSAL;
}

module.exports = { validateTickCoinPrefix };
