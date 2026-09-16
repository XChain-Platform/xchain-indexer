const { getLogger } = require('../../observability/index.js');
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
 * ORDER_MATCH candidate gates: the token info and allow/block lists a pass reads
 * once, then per candidate the reciprocity gates, the remaining-amount and price
 * gates, the zero-fill and ownership-exactness gates and the allow/block lists.
 * fillMatch runs them in the order the matching loop always has and settles a
 * candidate that passes. The fill-amount arithmetic itself stays in order_match.js.
 *
 ********************************************************************/

// Installed onto Order_Match.prototype by order_match.js; each method runs with `this`
// bound to the handler, exactly as the class method it was.
module.exports = {

    // Token info for both ticks and the allow/block lists every candidate is checked against
    async loadOrderLists(data, orderInfo){

        // Get information on the tokens involved in the order
        let getTokenInfo  = await this.indexerDb.getTokenInfo(orderInfo['GET_TICK'],  data['BLOCK_INDEX'], data['ACTION_INDEX']);
        let giveTokenInfo = await this.indexerDb.getTokenInfo(orderInfo['GIVE_TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX']);

        // List of addresses allowed or blocked from holding GET_TICK
        let getTokenAllowList = (getTokenInfo && !this.util.isNull(getTokenInfo['ALLOW_LIST'])) ? await this.indexerDb.getList(getTokenInfo['ALLOW_LIST'], data['BLOCK_INDEX']) : [];
        let getTokenBlockList = (getTokenInfo && !this.util.isNull(getTokenInfo['BLOCK_LIST'])) ? await this.indexerDb.getList(getTokenInfo['BLOCK_LIST'], data['BLOCK_INDEX']) : [];

        // List of addresses allowed or blocked from holding GIVE_TICK
        let giveTokenAllowList = (giveTokenInfo && !this.util.isNull(giveTokenInfo['ALLOW_LIST'])) ? await this.indexerDb.getList(giveTokenInfo['ALLOW_LIST'], data['BLOCK_INDEX']) : [];
        let giveTokenBlockList = (giveTokenInfo && !this.util.isNull(giveTokenInfo['BLOCK_LIST'])) ? await this.indexerDb.getList(giveTokenInfo['BLOCK_LIST'], data['BLOCK_INDEX']) : [];

        // List of addresses allowed or blocked from matching with this ORDER
        let orderInfoAllowList = (!this.util.isNull(orderInfo['ALLOW_LIST'])) ? await this.indexerDb.getList(orderInfo['ALLOW_LIST'], data['BLOCK_INDEX']) : [];
        let orderInfoBlockList = (!this.util.isNull(orderInfo['BLOCK_LIST'])) ? await this.indexerDb.getList(orderInfo['BLOCK_LIST'], data['BLOCK_INDEX']) : [];

        return { getTokenInfo, giveTokenInfo, getTokenAllowList, getTokenBlockList, giveTokenAllowList,
                 giveTokenBlockList, orderInfoAllowList, orderInfoBlockList };
    },

    // One candidate: every gate in the order the matching loop runs them, then the fill
    // amounts and settlement. A failed gate returns with no effect, where the loop body
    // this came from would `continue` to the next candidate.
    async fillMatch(data, orderInfo, matchInfo, order, match, lists){

        if(!this.isTokenReciprocal(orderInfo, matchInfo))
            return;
        if(!(await this.isNativeReciprocal(data, orderInfo, matchInfo)))
            return;

        // Set get/give remaining amounts for this order match
        match['GIVE_REMAINING'] = matchInfo['GIVE_REMAINING'];
        match['GET_REMAINING']  = matchInfo['GET_REMAINING'];

        // Display get/give remaining amounts
        if(this.debug){
            getLogger().info('ORDER - GET / GIVE remaining=', order['GIVE_REMAINING'], order['GET_REMAINING'])
            getLogger().info('MATCH - GIVE / GET remaining=', match['GET_REMAINING'],  match['GIVE_REMAINING'])
        }

        if(!this.hasFillRoom(orderInfo, matchInfo, order, match))
            return;

        // Both fill amounts at precision 64, snapped onto each side's tick grid (order_match.js)
        let fill = this.computeFillAmounts(orderInfo, matchInfo, order, lists);
        if(!this.isNonZeroFill(fill))
            return;
        if(!this.isOwnershipFillExact(orderInfo, matchInfo, fill))
            return;
        if(!(await this.isListAllowed(data, orderInfo, matchInfo, lists)))
            return;

        // Book and settle the fill (order_match/settle.js)
        await this.settleFill(data, orderInfo, matchInfo, order, match, fill);
    },

    // Reciprocity gate (defense-in-depth for the findOrderMatches reverse-leg
    // constraint). Scoped to the INSTANT token-for-token path (all four ticks
    // non-null); the native-coin / COINPay path (any null tick) settles two-phase
    // with its own routing and is intentionally asymmetric, so it is left untouched.
    // On the instant path settlement hardcodes reciprocity (releases/credits
    // orderInfo.GET_TICK, matchInfo.GET_TICK), so BOTH legs must be an exact
    // tick+coin mirror: what this order GIVES must equal what the match GETS, and
    // what it GETS must equal what the match GIVES. A non-mirrored pair would credit
    // the taker a token the maker never escrowed (a mint out of the global escrow pool).
    isTokenReciprocal(orderInfo, matchInfo){
        let bothTokenLegs = !this.util.isNull(orderInfo['GIVE_TICK']) && !this.util.isNull(orderInfo['GET_TICK']) &&
                            !this.util.isNull(matchInfo['GIVE_TICK']) && !this.util.isNull(matchInfo['GET_TICK']);
        if(bothTokenLegs &&
           (String(orderInfo['GIVE_TICK']) !== String(matchInfo['GET_TICK'])  || String(orderInfo['GIVE_COIN']) !== String(matchInfo['GET_COIN']) ||
            String(orderInfo['GET_TICK'])  !== String(matchInfo['GIVE_TICK']) || String(orderInfo['GET_COIN'])  !== String(matchInfo['GIVE_COIN']))){
            if(this.debug)
                getLogger().info('Skipping non-reciprocal match (tick/coin mismatch)', orderInfo['GIVE_TICK'], orderInfo['GET_TICK'], matchInfo['GIVE_TICK'], matchInfo['GET_TICK']);
            return false;
        }
        return true;
    },

    // Native-coin (COINPay) reciprocity: the mirror of the bothTokenLegs gate for the
    // two-phase path. findOrderMatches enforces the forward leg strictly but NULL-relaxes
    // the reverse leg (orderInfo.GET == matchInfo.GIVE), so a token-for-COIN order
    // (GET_TICK null) can pair with a token-for-token maker whose GIVE_TICK is a real
    // token. That pair is NOT a coin trade: no side gives native coin to the coin-wanting
    // side, yet native settlement below would mint a bogus COINPay obligation and
    // mis-assign the coin/seller roles, because this file's GET_TICK-aware detection
    // disagrees with coinpay.js / coinpay_expire.js's single-GIVE_TICK detection and so
    // releases the wrong order's escrowed token. A legitimate native match mirrors both
    // legs exactly (null-to-null, or the same real token+coin), so exactly one side GIVES
    // native coin; anything else is rejected. Gated by COINPAY_NATIVE_RECIPROCITY because
    // it is consensus-visible (changes which matches settle) and must flip at a
    // coordinated block, staying byte-identical below it.
    async isNativeReciprocal(data, orderInfo, matchInfo){
        let anyNullTick = this.util.isNull(orderInfo['GIVE_TICK']) || this.util.isNull(orderInfo['GET_TICK']) ||
                          this.util.isNull(matchInfo['GIVE_TICK']) || this.util.isNull(matchInfo['GET_TICK']);
        if(anyNullTick && await this.actions.protocolChanges.isEnabled('COINPAY_NATIVE_RECIPROCITY', data['BLOCK_INDEX'])){
            let forwardMirror = (this.util.isNull(orderInfo['GIVE_TICK']) && this.util.isNull(matchInfo['GET_TICK'])) ||
                                (!this.util.isNull(orderInfo['GIVE_TICK']) && !this.util.isNull(matchInfo['GET_TICK']) &&
                                 String(orderInfo['GIVE_TICK']) === String(matchInfo['GET_TICK']) &&
                                 String(orderInfo['GIVE_COIN']) === String(matchInfo['GET_COIN']));
            let reverseMirror = (this.util.isNull(orderInfo['GET_TICK']) && this.util.isNull(matchInfo['GIVE_TICK'])) ||
                                (!this.util.isNull(orderInfo['GET_TICK']) && !this.util.isNull(matchInfo['GIVE_TICK']) &&
                                 String(orderInfo['GET_TICK']) === String(matchInfo['GIVE_TICK']) &&
                                 String(orderInfo['GET_COIN']) === String(matchInfo['GIVE_COIN']));
            if(!forwardMirror || !reverseMirror){
                if(this.debug)
                    getLogger().info('Skipping non-reciprocal native match (leg mismatch)', orderInfo['GIVE_TICK'], orderInfo['GET_TICK'], matchInfo['GIVE_TICK'], matchInfo['GET_TICK']);
                return false;
            }
        }
        return true;
    },

    // Both sides still have something to GIVE and GET, and the prices cross
    hasFillRoom(orderInfo, matchInfo, order, match){

        // Ignore if we have nothing left to GIVE
        if(this.util.bclte(match['GIVE_REMAINING'], 0) || this.util.bclte(order['GIVE_REMAINING'], 0)){
            if(this.debug)
                getLogger().info('Skipping: negative GIVE quantity remaining ', match['GIVE_REMAINING'], order['GIVE_REMAINING']);
            return false;
        }

        // Ignore if we have nothing left to GET
        if(this.util.bclte(match['GET_REMAINING'], 0) || this.util.bclte(order['GET_REMAINING'], 0)){
            if(this.debug)
                getLogger().info('Skipping: negative GET quantity remaining ', match['GET_REMAINING'], order['GET_REMAINING']);
            return false;
        }

        // Ignore price mismatches
        if(this.util.bcgt(matchInfo['GET_PRICE'], orderInfo['GIVE_PRICE'])){
            if(this.debug)
                getLogger().info('Skipping due to price mismatch ', matchInfo['GET_PRICE'], orderInfo['GIVE_PRICE']);
            return false;
        }
        return true;
    },

    // A fill that quantized to zero on either side is dropped, never settled as dust
    isNonZeroFill(fill){
        let { give_amount, get_amount } = fill;

        // Ignore zero quantity GIVE
        if(this.util.bclte(give_amount, 0)){
            if(this.debug)
                getLogger().info('Skipping zero quantity GIVE amount ', give_amount);
            return false;
        }

        // Ignore zero quantity GET
        if(this.util.bclte(get_amount, 0)){
            if(this.debug)
                getLogger().info('Skipping zero quantity GET amount ', get_amount);
            return false;
        }
        return true;
    },

    // Ownership orders are single-fill: amounts must exactly equal the order's
    // canonical sides (no partials). The counter-order must offer the full price.
    isOwnershipFillExact(orderInfo, matchInfo, fill){
        let { give_amount, get_amount } = fill;
        let orderIsOwnership = (Number(orderInfo['GIVE_OWNERSHIP']||0)==1 || Number(orderInfo['GET_OWNERSHIP']||0)==1);
        let matchIsOwnership = (Number(matchInfo['GIVE_OWNERSHIP']||0)==1 || Number(matchInfo['GET_OWNERSHIP']||0)==1);
        if(orderIsOwnership || matchIsOwnership){
            let expectedGive = (Number(orderInfo['GIVE_OWNERSHIP']||0)==1) ? '1' : orderInfo['GIVE_AMOUNT'];
            let expectedGet  = (Number(orderInfo['GET_OWNERSHIP']||0)==1)  ? '1' : orderInfo['GET_AMOUNT'];
            // Equality is written as "not greater and not less" because these amounts are
            // BigNumber strings: a direct == compares text, so '1.0' and '1' would read as
            // different fills and an ownership order would be refused a counter-party that
            // offered exactly the asked price.
            let giveEqual = (!this.util.bcgt(give_amount, expectedGive) && !this.util.bclt(give_amount, expectedGive));
            let getEqual  = (!this.util.bcgt(get_amount,  expectedGet)  && !this.util.bclt(get_amount,  expectedGet));
            if(!giveEqual || !getEqual){
                if(this.debug)
                    getLogger().info('Skipping ownership match: amounts must be exact (single-fill)', give_amount, expectedGive, get_amount, expectedGet);
                return false;
            }
        }
        return true;
    },

    // Both GET_ADDRESSes pass the token lists, this order's lists and the candidate's own
    async isListAllowed(data, orderInfo, matchInfo, lists){
        let { getTokenAllowList, getTokenBlockList, giveTokenAllowList, giveTokenBlockList,
              orderInfoAllowList, orderInfoBlockList } = lists;

        // List of addresses allowed or blocked from matching with this matching ORDER
        let matchInfoAllowList = (!this.util.isNull(matchInfo['ALLOW_LIST'])) ? await this.indexerDb.getList(matchInfo['ALLOW_LIST'], data['BLOCK_INDEX']) : [];
        let matchInfoBlockList = (!this.util.isNull(matchInfo['BLOCK_LIST'])) ? await this.indexerDb.getList(matchInfo['BLOCK_LIST'], data['BLOCK_INDEX']) : [];

        // Check if GET_ADDRESS for both sides of swap are allowed (ALLOW/BLOCK list support)
        if((getTokenAllowList.length  && (!getTokenAllowList.includes(orderInfo['GET_ADDRESS'])  || !getTokenAllowList.includes(matchInfo['GET_ADDRESS'])))  ||
           (getTokenBlockList.length  && ( getTokenBlockList.includes(orderInfo['GET_ADDRESS'])  ||  getTokenBlockList.includes(matchInfo['GET_ADDRESS'])))  ||
           (giveTokenAllowList.length && (!giveTokenAllowList.includes(orderInfo['GET_ADDRESS']) || !giveTokenAllowList.includes(matchInfo['GET_ADDRESS']))) ||
           (giveTokenBlockList.length && ( giveTokenBlockList.includes(orderInfo['GET_ADDRESS']) ||  giveTokenBlockList.includes(matchInfo['GET_ADDRESS']))) ||
           (orderInfoAllowList.length && !orderInfoAllowList.includes(matchInfo['GET_ADDRESS'])) ||
           (orderInfoBlockList.length &&  orderInfoBlockList.includes(matchInfo['GET_ADDRESS'])) ||
           (matchInfoAllowList.length && !matchInfoAllowList.includes(orderInfo['GET_ADDRESS'])) ||
           (matchInfoBlockList.length &&  matchInfoBlockList.includes(orderInfo['GET_ADDRESS']))){
            if(this.debug)
                getLogger().info('Skipping match due to allow/block list');
            return false;
        }
        return true;
    }
};
