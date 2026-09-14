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
 * XChain Platform Action - SWAP_MATCH
 *
 * This action finds and processes matching swap actions
 *
 ********************************************************************/

// The handler's phases, grouped by concern and installed onto Swap_Match.prototype below
const matchPart  = require('./swap_match/match.js');
const settlePart = require('./swap_match/settle.js');

class Swap_Match {

    // Handle constructing a class instance
    constructor(action){
        // Setup short aliases
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;
    }

    // Handle looking for a matching swap
    async parse(params, data, error){

        // Clone the raw data into a swap object
        let swap = Object.assign({}, data);

        // Get information on a swap given the COIN network and SWAP_ACTION_INDEX
        let swapIndex = (!this.util.isNull(data['SWAP_ACTION_INDEX'])) ? data['SWAP_ACTION_INDEX'] : data['ACTION_INDEX'];
        let swapInfo  = await this.indexerDb.getSwapInfo(this.config['COIN'], swapIndex)

        // Bail out if swap no longer exists (already expired or rolled back)
        if(!swapInfo)
            return;

        // Get a list of any matching open swaps
        let matches = await this.indexerDb.findSwapMatches(data);

        // Filter for ownership compatibility: an ownership-side and a balance-side
        // never match; both sides' GIVE_OWNERSHIP / GET_OWNERSHIP must mirror.
        if(matches){
            matches = matches.filter(m =>
                Number(m['GIVE_OWNERSHIP']||0) === Number(swapInfo['GET_OWNERSHIP']||0) &&
                Number(m['GET_OWNERSHIP']||0)  === Number(swapInfo['GIVE_OWNERSHIP']||0)
            );
            if(matches.length === 0) matches = false;
        }

        if(matches){

            // The first candidate that passes reciprocity and the allow/block lists (swap_match/match.js)
            let matchInfo = await this.findSwapMatch(data, swap, swapInfo, matches);

            // Process the swap match
            // TODO : Revisit this code once multi-chain swap support is added to xchain-hub component
            if(matchInfo)
                await this.settleSwapMatch(data, swapInfo, matchInfo);   // swap_match/settle.js
        }

    }
}

// Install the phase methods from swap_match/ NON-ENUMERABLE, the shape the class body they
// came from produced: parse() reaches them as this.<method>, suites can stub them through
// Swap_Match.prototype, and for-in over a handler stays empty. Same install as db/index.js
// uses for its query mixins.
for(const part of [matchPart, settlePart]){
    const descriptors = Object.getOwnPropertyDescriptors(part);
    for(const key of Reflect.ownKeys(descriptors)) descriptors[key].enumerable = false;
    Object.defineProperties(Swap_Match.prototype, descriptors);
}

module.exports = Swap_Match;
