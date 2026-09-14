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
 * SWAP_MATCH candidate selection: the token info and allow/block lists a pass
 * reads once, and the scan that takes the FIRST candidate passing both the
 * token-leg reciprocity gate and every allow/block list.
 *
 ********************************************************************/

// Installed onto Swap_Match.prototype by swap_match.js; each method runs with `this`
// bound to the handler, exactly as the class method it was.
module.exports = {

    // Token info for both ticks and the allow/block lists every candidate is checked against
    async loadSwapLists(data, swap, swapInfo){

        // Get information on the tokens involved in the swap
        let getTokenInfo  = await this.indexerDb.getTokenInfo(swapInfo['GET_TICK'],  swap['BLOCK_INDEX'], swap['ACTION_INDEX']);
        let giveTokenInfo = await this.indexerDb.getTokenInfo(swapInfo['GIVE_TICK'], swap['BLOCK_INDEX'], swap['ACTION_INDEX']);

        // List of addresses allowed or blocked from holding GET_TICK
        let getTokenAllowList  = (getTokenInfo  && !this.util.isNull(getTokenInfo['ALLOW_LIST']))  ? await this.indexerDb.getList(getTokenInfo['ALLOW_LIST'], data['BLOCK_INDEX'])  : [];
        let getTokenBlockList  = (getTokenInfo  && !this.util.isNull(getTokenInfo['BLOCK_LIST']))  ? await this.indexerDb.getList(getTokenInfo['BLOCK_LIST'], data['BLOCK_INDEX'])  : [];

        // List of addresses allowed or blocked from holding GIVE_TICK
        let giveTokenAllowList = (giveTokenInfo && !this.util.isNull(giveTokenInfo['ALLOW_LIST'])) ? await this.indexerDb.getList(giveTokenInfo['ALLOW_LIST'], data['BLOCK_INDEX']) : [];
        let giveTokenBlockList = (giveTokenInfo && !this.util.isNull(giveTokenInfo['BLOCK_LIST'])) ? await this.indexerDb.getList(giveTokenInfo['BLOCK_LIST'], data['BLOCK_INDEX']) : [];

        // List of addresses allowed or blocked from matching with this SWAP
        let swapInfoAllowList = (!this.util.isNull(swapInfo['ALLOW_LIST'])) ? await this.indexerDb.getList(swapInfo['ALLOW_LIST'], data['BLOCK_INDEX']) : [];
        let swapInfoBlockList = (!this.util.isNull(swapInfo['BLOCK_LIST'])) ? await this.indexerDb.getList(swapInfo['BLOCK_LIST'], data['BLOCK_INDEX']) : [];

        return { getTokenAllowList, getTokenBlockList, giveTokenAllowList, giveTokenBlockList, swapInfoAllowList, swapInfoBlockList };
    },

    // The first candidate that passes reciprocity and the allow/block lists, or false
    async findSwapMatch(data, swap, swapInfo, matches){
        let { getTokenAllowList, getTokenBlockList, giveTokenAllowList, giveTokenBlockList,
              swapInfoAllowList, swapInfoBlockList } = await this.loadSwapLists(data, swap, swapInfo);

        // Loop through matches and determine if we have a valid match
        let matchInfo = false;
        for(let match of matches){
            let valid = true;

            // Reciprocity gate (defense-in-depth for the findSwapMatches reverse-leg
            // constraint). Scoped to the token-for-token path (all four ticks non-null); a
            // null-tick (native/other) side is left to its own routing. Settlement below
            // hardcodes reciprocity (credits swapInfo.GET_TICK / matchInfo.GET_TICK), so BOTH
            // legs must be an exact tick+coin mirror: what this swap GIVES must equal what the
            // match GETS, and what it GETS must equal what the match GIVES. A non-mirrored pair
            // would credit the taker a token the maker never escrowed (a mint out of the
            // global escrow pool).
            let bothTokenLegs = !this.util.isNull(swapInfo['GIVE_TICK']) && !this.util.isNull(swapInfo['GET_TICK']) &&
                                !this.util.isNull(match['GIVE_TICK']) && !this.util.isNull(match['GET_TICK']);
            if(bothTokenLegs &&
               (String(swapInfo['GIVE_TICK']) !== String(match['GET_TICK'])  || String(swapInfo['GIVE_COIN']) !== String(match['GET_COIN']) ||
                String(swapInfo['GET_TICK'])  !== String(match['GIVE_TICK']) || String(swapInfo['GET_COIN'])  !== String(match['GIVE_COIN']))){
                valid = false;
            }

            // List of addresses allowed or blocked from matching with this matching SWAP
            let matchInfoAllowList = (!this.util.isNull(match['ALLOW_LIST'])) ? await this.indexerDb.getList(match['ALLOW_LIST'], data['BLOCK_INDEX']) : [];
            let matchInfoBlockList = (!this.util.isNull(match['BLOCK_LIST'])) ? await this.indexerDb.getList(match['BLOCK_LIST'], data['BLOCK_INDEX']) : [];

            // Check if GET_ADDRESS for both sides of swap are allowed (ALLOW/BLOCK list support)
            if((getTokenAllowList.length  && (!getTokenAllowList.includes(swapInfo['GET_ADDRESS'])  || !getTokenAllowList.includes(match['GET_ADDRESS'])))  ||
               (getTokenBlockList.length  && ( getTokenBlockList.includes(swapInfo['GET_ADDRESS'])  ||  getTokenBlockList.includes(match['GET_ADDRESS'])))  ||
               (giveTokenAllowList.length && (!giveTokenAllowList.includes(swapInfo['GET_ADDRESS']) || !giveTokenAllowList.includes(match['GET_ADDRESS']))) ||
               (giveTokenBlockList.length && ( giveTokenBlockList.includes(swapInfo['GET_ADDRESS']) ||  giveTokenBlockList.includes(match['GET_ADDRESS']))) ||
               (swapInfoAllowList.length  && !swapInfoAllowList.includes(match['GET_ADDRESS']))     ||
               (swapInfoBlockList.length  &&  swapInfoBlockList.includes(match['GET_ADDRESS']))     ||
               (matchInfoAllowList.length && !matchInfoAllowList.includes(swapInfo['GET_ADDRESS'])) ||
               (matchInfoBlockList.length &&  matchInfoBlockList.includes(swapInfo['GET_ADDRESS']))){
                valid = false;
            }

            // If we found a valid match, stop looking for additional matches
            if(valid){
                matchInfo = match;
                break;
            }
        }
        return matchInfo;
    }
};
