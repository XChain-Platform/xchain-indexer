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
 * DESTROY legs: the [TICK, AMOUNT, MEMO] triples one action names, the token row for
 * each tick, and the consolidation that merges legs sharing a TICK and MEMO.
 *
 * The functions that read the handler's config, util or indexerDb run with `this`
 * bound to the Destroy handler (./index.js calls them as fn.call(this, ...)).
 *
 ********************************************************************/

'use strict';

const gateRegistry = require('../../consensus/gate_registry');

const TICK_CACHE_GATE = 'tick_cache_null_prototype_activation.TICK_CACHE_NULL_PROTOTYPE_ACTIVATION';

function createTickCache(handler, data){
    let config = handler.config;
    let active = config && typeof config['NETWORK'] === 'string' && typeof config['COIN'] === 'string' &&
        gateRegistry.activeAt(TICK_CACHE_GATE, config['NETWORK'], config['COIN'],
            Number(data['BLOCK_INDEX']), null);
    return active ? Object.create(null) : {};
}

// The legs one DESTROY names, in wire order. A VERSION error still yields one leg, so a
// refused action leaves its row in the destroys table.
function buildDestroys(params, format, error){
    // Array of destroys [TICK, AMOUNT, MEMO]
    let destroys = [];

    // Extract memo
    let memo = null;
    let last = params.length - 1;
    for(let idx in params)
        if(idx==last && ((format==0 && idx==3) || (format==1 && idx%2==1)))
            memo = params[idx];

    // If we encountered an invalid version error add it to the destroys list so we create a record of it in destroys
    if(error)
        destroys.push([params[0], params[1], memo]);

    // Build out array of destroys
    let lastIdx = params.length - 1;
    for(let idx in params){
        // Force index to integer value
        idx = parseInt(idx);

        // Single Destroy
        if(format==0 && idx==0)
            destroys.push([params[1], params[2], memo]);

        // Multi-Destroy (Full)
        // A trailing memo (when present) always sits at the odd last index, so the
        // idx%2==0 test already excludes it; the extra `idx < lastIdx` guard wrongly
        // dropped the final tick/amount pair whenever no trailing memo was supplied.
        if(format==1 && idx>1 && idx%2==0)
            destroys.push([params[idx-1], params[idx], memo]);

        // Multi-Destroy (Full) with Multiple Memos
        if(format==2 && idx>0 && idx%3==1 && idx < lastIdx)
            destroys.push([params[idx], params[(idx+1)], params[idx+2], params[idx+3]]);
    }

    return destroys;
}

// The token row for every distinct TICK the legs name, read once each in leg order.
async function loadTicks(destroys, data){
    // Get token data for every TICK (reduces duplicated sql queries)
    let ticks = createTickCache(this, data);
    for(let destroy of destroys){
        let tick = destroy[0];
        if(ticks[tick] === undefined)
            ticks[tick] = await this.indexerDb.getTokenInfo(tick, data['BLOCK_INDEX'], data['ACTION_INDEX']);
    }
    return ticks;
}

// Consolidate destroys by TICK and MEMO.
//
// Same rule as the SEND leg merge: a leg whose RAW amount fails its tick's
// format is held out of the merge on its own key, so it reaches the per-leg format check
// below rather than being summed into a passing total.
function consolidateLegs(destroys, ticks, data){
    let keys = {};
    for(let idx in destroys){
        let [tick, amount, memo] = destroys[idx];
        let key = tick + '|' + memo;
        key = (ticks[tick] && !this.util.isValidAmountMergeFormat(ticks[tick]['DECIMALS'], amount, data['BLOCK_TIME']))
            ? 'i|' + idx
            : 'k|' + key;
        // An unknown TICK maps to false in `ticks`; it merges at 0 decimals, as an unlooked-up
        // one does, and validation then refuses the leg. Passing false through would make
        // bcadd's precision NaN, which throws and halts the block.
        if(!this.util.isNull(keys[key]))
            amount = this.util.bcadd(amount, keys[key][1], ticks[tick] ? ticks[tick]['DECIMALS'] : null);
        keys[key] = [tick, amount, memo];
    }

    // Update destroys using consolidated info
    destroys = [];
    for(let key in keys)
        destroys.push(keys[key]);

    return destroys;
}

module.exports = { buildDestroys, loadTicks, consolidateLegs };
