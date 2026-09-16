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
 * XChain Platform Action - ORDER_MATCH
 *
 * This action finds and processes matching order actions
 *
 ********************************************************************/

// The handler's phases, grouped by concern and installed onto Order_Match.prototype below:
// match.js (the per-candidate gates and fillMatch) and settle.js (booking and settlement).
// The fill-amount arithmetic stays in this file, below parse().
const matchPart  = require('./match.js');
const settlePart = require('./settle.js');

class Order_Match {

    // Handle constructing a class instance
    constructor(action){
        // Setup short aliases
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;

        // Flag to print debugging messages to the console
        this.debug = false;
    }

    // Handle looking for matching orders
    async parse(params, data, error){

        // Placeholder to store match and order info (get/give remaining amounts)
        let match = {};
        let order = {};

        // Get information on a order given the COIN network and ORDER_ACTION_INDEX
        let orderIndex = (data['ORDER_ACTION_INDEX']) ? data['ORDER_ACTION_INDEX'] : data['ACTION_INDEX'];
        let orderInfo  = await this.indexerDb.getOrderInfo(this.config['COIN'], orderIndex);

        // Bail out if order no longer exists (already expired or rolled back)
        if(!orderInfo)
            return;

        // Get a list of any matching open orders
        let matches = await this.indexerDb.findOrderMatches(orderInfo);

        // Filter for ownership compatibility: an ownership-side and a balance-side
        // never match; both sides' GIVE_OWNERSHIP / GET_OWNERSHIP must mirror.
        if(matches){
            matches = matches.filter(m =>
                Number(m['GIVE_OWNERSHIP']||0) === Number(orderInfo['GET_OWNERSHIP']||0) &&
                Number(m['GET_OWNERSHIP']||0)  === Number(orderInfo['GIVE_OWNERSHIP']||0)
            );
            // Collapse an emptied list back to false: every test below asks whether `matches`
            // is truthy, and an empty array answers yes, so the fill loop would run over
            // nothing and record a match that never happened.
            if(matches.length === 0) matches = false;
        }

        if(matches){

            // Token info and the allow/block lists every candidate is checked against
            // (order_match/match.js)
            let lists = await this.loadOrderLists(data, orderInfo);

            // Set get/give remaining amounts for this order
            order['GIVE_REMAINING'] = orderInfo['GIVE_REMAINING'];
            order['GET_REMAINING']  = orderInfo['GET_REMAINING'];

            // Loop through matches and determine if we have a valid match
            for(let matchInfo of matches){

                // Reset the address/tickers/transactions list on each match
                this.util.resetLists();

                // Gate, size and settle this candidate (order_match/match.js)
                await this.fillMatch(data, orderInfo, matchInfo, order, match, lists);
            }
        }
    }

    // Calculate the give and get amounts for this order match.
    //
    // Both orders constrain the trade: give_amount (orderInfo.GIVE_TICK =
    // matchInfo.GET_TICK) is bounded by matchInfo.GET_REMAINING and the taker's RUNNING
    // give-remaining; get_amount (orderInfo.GET_TICK = matchInfo.GIVE_TICK) by
    // matchInfo.GIVE_REMAINING and the taker's RUNNING get-remaining. The taker bound
    // must read order[...] (decremented after each fill), NOT orderInfo[...] (fetched
    // once above, never refreshed): across two makers in one pass the stale bound would
    // let a later fill release more escrow than the taker still has, over-releasing and
    // tripping the per-block supply sanity check.
    // Take whichever pair tightens first as the bottleneck, then derive the other amount
    // from the price at precision 64 (matching GET_PRICE/GIVE_PRICE), so the intermediate
    // carries no rounding noise; final quantization happens below.
    //
    // Kept in this file rather than order_match/: the DEX fill-quantization parity suite
    // reads this file's source and pins both clamp multiplications and both tick snaps.
    computeFillAmounts(orderInfo, matchInfo, order, lists){
        let { giveTokenInfo, getTokenInfo } = lists;
        let max_give = this.util.bclt(matchInfo['GET_REMAINING'], order['GIVE_REMAINING'])
            ? matchInfo['GET_REMAINING']
            : order['GIVE_REMAINING'];
        let max_get = this.util.bclt(matchInfo['GIVE_REMAINING'], order['GET_REMAINING'])
            ? matchInfo['GIVE_REMAINING']
            : order['GET_REMAINING'];
        let give_from_get = this.util.bcmul(max_get, orderInfo['GET_PRICE'], 64);
        let give_amount, get_amount;
        if (this.util.bcgt(give_from_get, max_give)) {
            // give-side is the bottleneck: clamp give and derive get
            give_amount = max_give;
            get_amount  = this.util.bcmul(max_give, orderInfo['GIVE_PRICE'], 64);
        } else {
            // get-side is the bottleneck (or both equal): use full max_get
            give_amount = give_from_get;
            get_amount  = max_get;
        }

        // Snap each settled amount onto its own tick's decimal grid (give_amount in
        // orderInfo.GIVE_TICK = matchInfo.GET_TICK, get_amount in orderInfo.GET_TICK =
        // matchInfo.GIVE_TICK; native-coin sides, meaning a null tick and null tokenInfo,
        // use COIN_DECIMALS). This enforces indivisibility: a 0-decimal (NFT) tick is forced
        // to integer fills, and any token's fill is freed of sub-unit dust. Each derived
        // amount is <= its side's on-grid max, so rounding can never exceed the escrowed
        // remaining; a fill that rounds to zero is dropped by the guards just below.
        let giveDecimals = giveTokenInfo ? giveTokenInfo['DECIMALS'] : this.config['COIN_DECIMALS'];
        let getDecimals  = getTokenInfo  ? getTokenInfo['DECIMALS']  : this.config['COIN_DECIMALS'];
        give_amount = this.util.bcround(give_amount, giveDecimals);
        get_amount  = this.util.bcround(get_amount,  getDecimals);

        return { give_amount, get_amount, giveDecimals, getDecimals };
    }
}

// Install the phase methods from order_match/ NON-ENUMERABLE, the shape the class body they
// came from produced: parse() reaches them as this.<method>, suites can stub them through
// Order_Match.prototype, and for-in over a handler stays empty. Same install as db/index.js
// uses for its query mixins.
for(const part of [matchPart, settlePart]){
    const descriptors = Object.getOwnPropertyDescriptors(part);
    for(const key of Reflect.ownKeys(descriptors)) descriptors[key].enumerable = false;
    Object.defineProperties(Order_Match.prototype, descriptors);
}

module.exports = Order_Match;
