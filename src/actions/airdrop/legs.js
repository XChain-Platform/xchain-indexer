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
 * XChain Platform Action - AIRDROP: legs
 *
 * Reads the AIRDROP wire parameters into legs and loads the token info
 * of every TICK they name.
 *
 ********************************************************************/

// Installed onto Airdrop.prototype by index.js; each method runs with `this` bound to the
// handler, exactly as the class method it was.
module.exports = {

    // Read the wire parameters into legs, by FORMAT: 0 a single airdrop, 1 a brief multi-airdrop
    // to one LIST, 2 a full multi-airdrop, 3 a full multi-airdrop carrying a MEMO per leg
    readAirdropLegs(params, format){
        // [TICK, AMOUNT, LIST, MEMO] per airdrop leg.
        let airdrops = [];

        // Extract memo
        let memo = null;
        let last = params.length - 1;
        for(let idx in params)
            if(idx==last && ((format==0 && idx==4) || (format==1 && idx%2==0) || (format==2 && idx%3==1)))
                memo = params[idx];

        let lastIdx = params.length - 1;
        for(let idx in params){
            idx = parseInt(idx); // for-in yields string keys; the modulo checks below need integers

            // Format 0: Single Airdrop
            if(format==0 && idx==0)
                airdrops.push([params[1], params[2], params[3], memo]);

            // Format 1: Multi-Airdrop (Brief)
            if(format==1 && idx>1 && idx%2==1)
                airdrops.push([params[idx-1], params[idx], params[1], memo]);

            // Format 2: Multi-Airdrop (Full)
            if(format==2 && idx>0 && idx%3==1 && idx < lastIdx)
                airdrops.push([params[idx], params[(idx+1)], params[idx+2], memo]);

            // Format 3: Multi-Airdrop (Full) with Multiple Memos
            if(format==3 && idx>0 && idx%4==1 && idx < lastIdx)
                airdrops.push([params[idx], params[idx+1], params[idx+2], params[idx+3]]);
        }
        return airdrops;
    },

    // Fetch token info for each distinct TICK once, up front, instead of per airdrop leg.
    async fetchAirdropTicks(airdrops, data){
        let ticks = {};
        for(let airdrop of airdrops){
            let tick = airdrop[0];
            if(ticks[tick] === undefined)
                ticks[tick] = await this.indexerDb.getTokenInfo(tick, data['BLOCK_INDEX'], data['ACTION_INDEX']);
        }
        return ticks;
    }
};
