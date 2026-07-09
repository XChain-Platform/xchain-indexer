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
            // Get information on the tokens involved in the swap
            let getTokenInfo  = await this.indexerDb.getTokenInfo(swapInfo['GET_TICK'],  swap['BLOCK_INDEX'], swap['ACTION_INDEX']);
            let giveTokenInfo = await this.indexerDb.getTokenInfo(swapInfo['GIVE_TICK'], swap['BLOCK_INDEX'], swap['ACTION_INDEX']);

            // List of addresses allowed or blocked from holding GET_TICK
            let getTokenAllowList  = (getTokenInfo  && !this.util.isNull(getTokenInfo['ALLOW_LIST']))  ? await this.indexerDb.getList(getTokenInfo['ALLOW_LIST'])  : [];
            let getTokenBlockList  = (getTokenInfo  && !this.util.isNull(getTokenInfo['BLOCK_LIST']))  ? await this.indexerDb.getList(getTokenInfo['BLOCK_LIST'])  : [];

            // List of addresses allowed or blocked from holding GIVE_TICK
            let giveTokenAllowList = (giveTokenInfo && !this.util.isNull(giveTokenInfo['ALLOW_LIST'])) ? await this.indexerDb.getList(giveTokenInfo['ALLOW_LIST']) : [];
            let giveTokenBlockList = (giveTokenInfo && !this.util.isNull(giveTokenInfo['BLOCK_LIST'])) ? await this.indexerDb.getList(giveTokenInfo['BLOCK_LIST']) : [];

            // List of addresses allowed or blocked from matching with this SWAP
            let swapInfoAllowList = (!this.util.isNull(swapInfo['ALLOW_LIST'])) ? await this.indexerDb.getList(swapInfo['ALLOW_LIST']) : [];
            let swapInfoBlockList = (!this.util.isNull(swapInfo['BLOCK_LIST'])) ? await this.indexerDb.getList(swapInfo['BLOCK_LIST']) : [];

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
                let matchInfoAllowList = (!this.util.isNull(match['ALLOW_LIST'])) ? await this.indexerDb.getList(match['ALLOW_LIST']) : [];
                let matchInfoBlockList = (!this.util.isNull(match['BLOCK_LIST'])) ? await this.indexerDb.getList(match['BLOCK_LIST']) : [];

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

            // Process the swap match
            // TODO : Revisit this code once multi-chain swap support is added to xchain-hub component
            if(matchInfo){

                // Set the status to valid
                data['STATUS'] = 'valid';

                // Print status message
                console.log("\t SWAP_MATCH : " + swapInfo['GIVE_AMOUNT'] + ' ' + swapInfo['GIVE_COIN'] + ':' + swapInfo['GIVE_TICK'] + ' = '  +  swapInfo['GET_AMOUNT'] + ' ' + swapInfo['GET_COIN'] + ':' + swapInfo['GET_TICK'] + ' : ' + data['STATUS']);

                // Array of credits, debits, and escrows
                let credits = [],
                    debits  = [],
                    escrows = [];

                // Define SWAP_MATCH action
                let action = {}
                action['ACTION']      = 'SWAP_MATCH';
                action['BLOCK_INDEX'] = data['BLOCK_INDEX'];

                // Create a record of this SWAP_MATCH action in the actions table
                data['ACTION_INDEX'] = await this.indexerDb.createActionIndex(action);

                // Settlement: two sides settle independently:
                //   - swapInfo.GIVE → matchInfo.GET_ADDRESS
                //   - matchInfo.GIVE → swapInfo.GET_ADDRESS
                // Ownership sides clear the escrow gate and atomically transfer ownership;
                // balance sides keep the existing escrow/credit pattern.

                // swapInfo.GIVE side → matchInfo's proceeds. If matchInfo sold a controlled token, its
                // stored royalty/fee split applies to these proceeds (applyProceedsSplit returns the
                // lone full credit when there are no legs, so the call is unconditional).
                if(Number(swapInfo['GIVE_OWNERSHIP']||0) == 1){
                    await this.util.transferTokenOwnership(this.indexerDb, this.mapper, data, swapInfo['GIVE_TICK'], swapInfo['SOURCE'], matchInfo['GET_ADDRESS']);
                } else {
                    // Negate via bcsub, not JS unary minus: -GET_AMOUNT coerces the
                    // bignumber string to a float and loses digits past ~15 sig figs,
                    // de-syncing this escrow debit from the full-precision split credits
                    // below (applyProceedsSplit conserves exactly to GET_AMOUNT).
                    escrows.push([matchInfo['GET_TICK'], this.util.bcsub(0, matchInfo['GET_AMOUNT'], 64), matchInfo['GET_ADDRESS']]);
                    let mDec = 0;
                    if(!this.util.isNull(matchInfo['PAYOUT_LEGS'])){
                        let mInfo = await this.indexerDb.getTokenInfo(matchInfo['GET_TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX']);
                        mDec = (mInfo && !this.util.isNull(mInfo['DECIMALS'])) ? parseInt(mInfo['DECIMALS']) : 0;
                    }
                    for(let c of this.util.applyProceedsSplit(matchInfo['GET_TICK'], matchInfo['GET_AMOUNT'], matchInfo['GET_ADDRESS'], matchInfo['PAYOUT_LEGS'], mDec, parseInt(this.config['CONTROLLER_MAX_TAKE_BPS']))){
                        credits.push(c);
                        this.util.addAddressTicker(c[2], c[0]);
                    }
                }

                // matchInfo.GIVE side → swapInfo's proceeds. Same: apply swapInfo's stored split.
                if(Number(matchInfo['GIVE_OWNERSHIP']||0) == 1){
                    await this.util.transferTokenOwnership(this.indexerDb, this.mapper, data, matchInfo['GIVE_TICK'], matchInfo['SOURCE'], swapInfo['GET_ADDRESS']);
                } else {
                    // Negate via bcsub, not JS unary minus (see matchInfo side above):
                    // preserve full precision so the escrow debit mirrors the split credits.
                    escrows.push([swapInfo['GET_TICK'], this.util.bcsub(0, swapInfo['GET_AMOUNT'], 64), swapInfo['GET_ADDRESS']]);
                    let sDec = 0;
                    if(!this.util.isNull(swapInfo['PAYOUT_LEGS'])){
                        let sInfo = await this.indexerDb.getTokenInfo(swapInfo['GET_TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX']);
                        sDec = (sInfo && !this.util.isNull(sInfo['DECIMALS'])) ? parseInt(sInfo['DECIMALS']) : 0;
                    }
                    for(let c of this.util.applyProceedsSplit(swapInfo['GET_TICK'], swapInfo['GET_AMOUNT'], swapInfo['GET_ADDRESS'], swapInfo['PAYOUT_LEGS'], sDec, parseInt(this.config['CONTROLLER_MAX_TAKE_BPS']))){
                        credits.push(c);
                        this.util.addAddressTicker(c[2], c[0]);
                    }
                }

                // Process any transaction ledger changes (credits / debits / escrows)
                await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits, escrows);

                // Create record of match in swap_matches table
                await this.indexerDb.createSwapMatch(data, swapInfo, matchInfo);

                // Update record in swaps table to change status (open->complete)
                await this.indexerDb.createSwapStatus(data['ACTION_INDEX'], swapInfo['ACTION_INDEX'],  'complete');
                await this.indexerDb.createSwapStatus(data['ACTION_INDEX'], matchInfo['ACTION_INDEX'], 'complete');

                // Get a list of addresses
                let addresses = Object.keys(this.util.getAddressesList());

                // Update address balances
                await this.indexerDb.updateBalances(addresses);

                // Create action mappings
                await this.mapper.createMappings(data);
            }
        }

    }
}

module.exports = Swap_Match;