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
 * XChain Indexer - Rollback: retracted PRICE batch landing clocks
 *
 * The block_time a rolled-back PRICE batch's pushBatch sent, rebuilt for the price
 * retraction so the hub clears only the stamps that landing wrote.
 *
 ********************************************************************/

'use strict';

const protocolTime = require('../consensus/protocol_time.js');
const { getLogger } = require('../observability/index.js');

// pushBatch sends the landing block's protocol time. When a rollback runs, the decoder has
// already deleted or replaced the rolled-back blocks, so its blocks table cannot answer;
// this indexer's own blocks rows still hold that chain until the purge, and each stores the
// raw stamp the forward pass read. A clock is returned only when the block's own stamp and,
// on a median-time network, the full contiguous window below it are present, so a returned
// clock is the one the forward pass computed. Anything less is omitted, and the hub then
// keeps its whole-window reset, which only ever fails closed.
async function retractedLandingClocks(view, blockIndexes){
    let keys = [...new Set((Array.isArray(blockIndexes) ? blockIndexes : [])
        .filter(v => v !== null && v !== undefined).map(Number)
        .filter(v => Number.isSafeInteger(v) && v >= 0))];
    if(keys.length === 0 || !view || typeof view.getStoredBlockTimeWindows !== 'function') return new Map();
    let network = view.config ? view.config['NETWORK'] : undefined;
    let span = protocolTime.isProtocolTimeMtpActive(network) ? protocolTime.MEDIAN_TIME_SPAN : 0;
    let rows;
    try {
        rows = await view.getStoredBlockTimeWindows(keys, span);
    } catch(e){
        getLogger().warn('Rollback: could not read the retracted PRICE batch landing clocks; the hub resets each whole window: '
            + ((e && e.message) || e));
        return new Map();
    }
    let clocks = new Map();
    for(let key of keys){
        let clock = clockFromWindow(network, key, span, (Array.isArray(rows) ? rows : [])
            .filter(r => Number(r.requested_block_index) === key));
        if(clock !== null) clocks.set(key, clock);
    }
    return clocks;
}

// One block's clock from its stored window, or null unless every row the forward
// median read is present: the block itself, then key-1 down to key-span with no gap.
function clockFromWindow(network, key, span, window){
    let byIndex = new Map(window.map(r => [Number(r.block_index), r.block_time]));
    let previous = [];
    for(let i = 1; i <= span; i++){
        let t = byIndex.get(key - i);
        if(t === null || t === undefined) return null;
        previous.push(t);
    }
    let raw = byIndex.get(key);
    if(raw === null || raw === undefined) return null;
    let clock = Number(protocolTime.protocolTime(network, raw, previous));
    return (Number.isSafeInteger(clock) && clock > 0) ? clock : null;
}

module.exports = { retractedLandingClocks };
