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

class Order_Match {

    constructor(action){
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;

        this.debug = false;
    }

    async parse(params, data, error){

        let match = {};
        let order = {};

        let orderIndex = (data['ORDER_ACTION_INDEX']) ? data['ORDER_ACTION_INDEX'] : data['ACTION_INDEX'];
        let orderInfo  = await this.indexerDb.getOrderInfo(this.config['COIN'], orderIndex);

        // Bail out if order no longer exists (already expired or rolled back)
        if(!orderInfo)
            return;

        let matches = await this.indexerDb.findOrderMatches(orderInfo);

        // Filter for ownership compatibility: an ownership-side and a balance-side
        // never match; both sides' GIVE_OWNERSHIP / GET_OWNERSHIP must mirror.
        if(matches){
            matches = matches.filter(m =>
                Number(m['GIVE_OWNERSHIP']||0) === Number(orderInfo['GET_OWNERSHIP']||0) &&
                Number(m['GET_OWNERSHIP']||0)  === Number(orderInfo['GIVE_OWNERSHIP']||0)
            );
            if(matches.length === 0) matches = false;
        }

        if(matches){

            let getTokenInfo  = await this.indexerDb.getTokenInfo(orderInfo['GET_TICK'],  data['BLOCK_INDEX'], data['ACTION_INDEX']);
            let giveTokenInfo = await this.indexerDb.getTokenInfo(orderInfo['GIVE_TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX']);

            let getTokenAllowList = (getTokenInfo && !this.util.isNull(getTokenInfo['ALLOW_LIST'])) ? await this.indexerDb.getList(getTokenInfo['ALLOW_LIST'], data['BLOCK_INDEX']) : [];
            let getTokenBlockList = (getTokenInfo && !this.util.isNull(getTokenInfo['BLOCK_LIST'])) ? await this.indexerDb.getList(getTokenInfo['BLOCK_LIST'], data['BLOCK_INDEX']) : [];

            let giveTokenAllowList = (giveTokenInfo && !this.util.isNull(giveTokenInfo['ALLOW_LIST'])) ? await this.indexerDb.getList(giveTokenInfo['ALLOW_LIST'], data['BLOCK_INDEX']) : [];
            let giveTokenBlockList = (giveTokenInfo && !this.util.isNull(giveTokenInfo['BLOCK_LIST'])) ? await this.indexerDb.getList(giveTokenInfo['BLOCK_LIST'], data['BLOCK_INDEX']) : [];

            let orderInfoAllowList = (!this.util.isNull(orderInfo['ALLOW_LIST'])) ? await this.indexerDb.getList(orderInfo['ALLOW_LIST'], data['BLOCK_INDEX']) : [];
            let orderInfoBlockList = (!this.util.isNull(orderInfo['BLOCK_LIST'])) ? await this.indexerDb.getList(orderInfo['BLOCK_LIST'], data['BLOCK_INDEX']) : [];

            order['GIVE_REMAINING'] = orderInfo['GIVE_REMAINING'];
            order['GET_REMAINING']  = orderInfo['GET_REMAINING'];

            for(let matchInfo of matches){

                this.util.resetLists();

                // Reciprocity gate (defense-in-depth for the findOrderMatches reverse-leg
                // constraint). Scoped to the INSTANT token-for-token path (all four ticks
                // non-null); the native-coin / COINPay path (any null tick) settles two-phase
                // with its own routing and is intentionally asymmetric, so it is left untouched.
                // On the instant path settlement hardcodes reciprocity (releases/credits
                // orderInfo.GET_TICK, matchInfo.GET_TICK), so BOTH legs must be an exact
                // tick+coin mirror: what this order GIVES must equal what the match GETS, and
                // what it GETS must equal what the match GIVES. A non-mirrored pair would credit
                // the taker a token the maker never escrowed (a mint out of the global escrow pool).
                let bothTokenLegs = !this.util.isNull(orderInfo['GIVE_TICK']) && !this.util.isNull(orderInfo['GET_TICK']) &&
                                    !this.util.isNull(matchInfo['GIVE_TICK']) && !this.util.isNull(matchInfo['GET_TICK']);
                if(bothTokenLegs &&
                   (String(orderInfo['GIVE_TICK']) !== String(matchInfo['GET_TICK'])  || String(orderInfo['GIVE_COIN']) !== String(matchInfo['GET_COIN']) ||
                    String(orderInfo['GET_TICK'])  !== String(matchInfo['GIVE_TICK']) || String(orderInfo['GET_COIN'])  !== String(matchInfo['GIVE_COIN']))){
                    if(this.debug)
                        console.log('Skipping non-reciprocal match (tick/coin mismatch)', orderInfo['GIVE_TICK'], orderInfo['GET_TICK'], matchInfo['GIVE_TICK'], matchInfo['GET_TICK']);
                    continue;
                }

                // Native-coin (COINPay) reciprocity: the mirror of the bothTokenLegs gate for the
                // two-phase path. findOrderMatches enforces the forward leg strictly but NULL-relaxes
                // the reverse leg, so a token-for-COIN order can pair with a token-for-token maker
                // whose GIVE_TICK is a real token. That pair is NOT a coin trade: no side gives native
                // coin, yet native settlement below would mint a bogus COINPay obligation and
                // mis-assign the coin/seller roles. A legitimate native match mirrors both legs
                // exactly (null-to-null, or the same real token+coin), so exactly one side GIVES
                // native coin; anything else is rejected. Gated because it is consensus-visible
                // (changes which matches settle) and must flip at a coordinated block.
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
                            console.log('Skipping non-reciprocal native match (leg mismatch)', orderInfo['GIVE_TICK'], orderInfo['GET_TICK'], matchInfo['GIVE_TICK'], matchInfo['GET_TICK']);
                        continue;
                    }
                }

                match['GIVE_REMAINING'] = matchInfo['GIVE_REMAINING'];
                match['GET_REMAINING']  = matchInfo['GET_REMAINING'];

                if(this.debug){
                    console.log('ORDER - GET / GIVE remaining=', order['GIVE_REMAINING'], order['GET_REMAINING'])
                    console.log('MATCH - GIVE / GET remaining=', match['GET_REMAINING'],  match['GIVE_REMAINING'])
                }

                // Ignore if we have nothing left to GIVE
                if(this.util.bclte(match['GIVE_REMAINING'], 0) || this.util.bclte(order['GIVE_REMAINING'], 0)){
                    if(this.debug)
                        console.log('Skipping: negative GIVE quantity remaining ', match['GIVE_REMAINING'], order['GIVE_REMAINING']);
                    continue;
                }

                // Ignore if we have nothing left to GET
                if(this.util.bclte(match['GET_REMAINING'], 0) || this.util.bclte(order['GET_REMAINING'], 0)){
                    if(this.debug)
                        console.log('Skipping: negative GET quantity remaining ', match['GET_REMAINING'], order['GET_REMAINING']);
                    continue;
                }

                // Ignore price mismatches
                if(this.util.bcgt(matchInfo['GET_PRICE'], orderInfo['GIVE_PRICE'])){
                    if(this.debug)
                        console.log('Skipping due to price mismatch ', matchInfo['GET_PRICE'], orderInfo['GIVE_PRICE']);
                    continue;
                }

                // Calculate the give and get amounts for this order match.
                //
                // Both orders constrain the trade: give_amount is bounded by matchInfo.GET_REMAINING
                // and the taker's RUNNING give-remaining; get_amount by matchInfo.GIVE_REMAINING and
                // the taker's RUNNING get-remaining. The taker bound must read order[...] (decremented
                // after each fill), NOT orderInfo[...] (fetched once above, never refreshed): across
                // two makers in one pass the stale bound would let a later fill over-release escrow,
                // tripping the per-block supply sanity check.
                // Take whichever pair tightens first as the bottleneck, then derive the other amount
                // from the price at precision 64 (matching GET_PRICE/GIVE_PRICE), so the intermediate
                // carries no rounding noise; final quantization happens below.
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
                // orderInfo.GIVE_TICK, get_amount in orderInfo.GET_TICK; native-coin sides use
                // COIN_DECIMALS). This enforces indivisibility: a 0-decimal (NFT) tick is forced
                // to integer fills, and any token's fill is freed of sub-unit dust. Each derived
                // amount is <= its side's on-grid max, so rounding can never exceed the escrowed
                // remaining; a fill that rounds to zero is dropped by the guards just below.
                let giveDecimals = giveTokenInfo ? giveTokenInfo['DECIMALS'] : this.config['COIN_DECIMALS'];
                let getDecimals  = getTokenInfo  ? getTokenInfo['DECIMALS']  : this.config['COIN_DECIMALS'];
                give_amount = this.util.bcround(give_amount, giveDecimals);
                get_amount  = this.util.bcround(get_amount,  getDecimals);

                // Ignore zero quantity GIVE
                if(this.util.bclte(give_amount, 0)){
                    if(this.debug)
                        console.log('Skipping zero quantity GIVE amount ', give_amount);
                    continue;
                }

                // Ignore zero quantity GET
                if(this.util.bclte(get_amount, 0)){
                    if(this.debug)
                        console.log('Skipping zero quantity GET amount ', get_amount);
                    continue;
                }

                // Ownership orders are single-fill: amounts must exactly equal the order's
                // canonical sides (no partials). The counter-order must offer the full price.
                let orderIsOwnership = (Number(orderInfo['GIVE_OWNERSHIP']||0)==1 || Number(orderInfo['GET_OWNERSHIP']||0)==1);
                let matchIsOwnership = (Number(matchInfo['GIVE_OWNERSHIP']||0)==1 || Number(matchInfo['GET_OWNERSHIP']||0)==1);
                if(orderIsOwnership || matchIsOwnership){
                    let expectedGive = (Number(orderInfo['GIVE_OWNERSHIP']||0)==1) ? '1' : orderInfo['GIVE_AMOUNT'];
                    let expectedGet  = (Number(orderInfo['GET_OWNERSHIP']||0)==1)  ? '1' : orderInfo['GET_AMOUNT'];
                    let giveEqual = (!this.util.bcgt(give_amount, expectedGive) && !this.util.bclt(give_amount, expectedGive));
                    let getEqual  = (!this.util.bcgt(get_amount,  expectedGet)  && !this.util.bclt(get_amount,  expectedGet));
                    if(!giveEqual || !getEqual){
                        if(this.debug)
                            console.log('Skipping ownership match: amounts must be exact (single-fill)', give_amount, expectedGive, get_amount, expectedGet);
                        continue;
                    }
                }

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
                        console.log('Skipping match due to allow/block list');
                    continue;
                }

                // Update GET_REMAINING and GIVE_REMAINING in the orders.
                // Subtract at precision 64, matching getOrderAmountsRemaining's cross-block
                // derivation. bcsub's decimals default is 0, which rounds a fractional remaining
                // to a whole number: a remaining that rounds to 0 marks the order complete with
                // escrow still held, one that rounds up keeps filling past exhaustion.
                order['GIVE_REMAINING'] = this.util.bcsub(order['GIVE_REMAINING'], give_amount, 64);
                order['GET_REMAINING']  = this.util.bcsub(order['GET_REMAINING'],  get_amount,  64);
                match['GIVE_REMAINING'] = this.util.bcsub(match['GIVE_REMAINING'], get_amount,  64);
                match['GET_REMAINING']  = this.util.bcsub(match['GET_REMAINING'],  give_amount, 64);

                if(this.debug)
                    console.log('FINAL - GET / GIVE remaining=',order['GIVE_REMAINING'],order['GET_REMAINING'])

                // Detect if this is a native coin match (one side has null/empty TICK)
                let isNativeCoinMatch = (this.util.isNull(orderInfo['GIVE_TICK']) ||
                                         this.util.isNull(orderInfo['GET_TICK'])  ||
                                         this.util.isNull(matchInfo['GIVE_TICK']) ||
                                         this.util.isNull(matchInfo['GET_TICK']));

                data['STATUS'] = isNativeCoinMatch ? 'pending_coinpay' : 'valid';
                data['SETTLEMENT_TYPE'] = isNativeCoinMatch ? 'coinpay' : 'instant';

                console.log("\t ORDER_MATCH : " + give_amount + ' ' + orderInfo['GIVE_COIN'] + ':' + (orderInfo['GIVE_TICK'] || orderInfo['GIVE_COIN']) + ' = '  + get_amount + ' ' + data['GET_COIN'] + ':' + (data['GET_TICK'] || data['GET_COIN']) + ' : ' + data['STATUS']);

                let credits = [],
                    debits  = [],
                    escrows = [];

                let action = {}
                action['ACTION']      = 'ORDER_MATCH';
                action['BLOCK_INDEX'] = data['BLOCK_INDEX'];

                action['ACTION_INDEX'] = await this.indexerDb.createActionIndex(action);

                data['ACTION_INDEX'] = action['ACTION_INDEX'];
                // Stringify in normal notation here so every downstream consumer (order_matches
                // insert, remaining-amount math, logs) sees the canonical decimal form; a raw
                // bignumber String()s to exponential below 1e-7 ("3e-8") and wedges the
                // state-commitment encoder.
                data['MATCH_GIVE_AMOUNT'] = this.util.bcstr(give_amount);
                data['MATCH_GET_AMOUNT']  = this.util.bcstr(get_amount);

                if(isNativeCoinMatch){
                    // Two-phase settlement: create COINPay obligation.
                    // Tokens stay escrowed; no credits/escrow changes until COINPay fulfills or expires.

                    let coinOrder, sellerOrder, nativeCoinAmount;
                    if(this.util.isNull(orderInfo['GIVE_TICK'])){
                        // orderInfo is offering native coin, matchInfo is selling tokens
                        coinOrder   = orderInfo;
                        sellerOrder = matchInfo;
                        nativeCoinAmount = give_amount;
                    } else if(this.util.isNull(matchInfo['GIVE_TICK'])){
                        // matchInfo is offering native coin, orderInfo is selling tokens
                        coinOrder   = matchInfo;
                        sellerOrder = orderInfo;
                        nativeCoinAmount = get_amount;
                    } else {
                        // GET_TICK is null on one side; the coin requester's counterparty is the coin payer
                        if(this.util.isNull(orderInfo['GET_TICK'])){
                            // orderInfo wants native coin, matchInfo must pay it
                            coinOrder   = matchInfo;
                            sellerOrder = orderInfo;
                            nativeCoinAmount = get_amount;
                        } else {
                            // matchInfo wants native coin, orderInfo must pay it
                            coinOrder   = orderInfo;
                            sellerOrder = matchInfo;
                            nativeCoinAmount = give_amount;
                        }
                    }

                    let obligationData = {
                        ACTION_INDEX:  data['ACTION_INDEX'],
                        PAYER_ADDRESS: coinOrder['SOURCE'],
                        PAYEE_ADDRESS: sellerOrder['GET_ADDRESS'],
                        COIN:          this.config['COIN'],
                        COIN_AMOUNT:   nativeCoinAmount,
                        EXPIRATION:    data['BLOCK_TIME'] + this.config['COINPAY_EXPIRATION'],
                        BLOCK_INDEX:   data['BLOCK_INDEX']
                    };
                    await this.indexerDb.createCoinpayObligation(obligationData);

                    await this.indexerDb.createCoinpayStatus(data['ACTION_INDEX'], data['ACTION_INDEX'], 'pending_coinpay');

                    if(!this.util.isNull(matchInfo['GET_TICK']))
                        this.util.addAddressTicker(matchInfo['GET_ADDRESS'], matchInfo['GET_TICK']);
                    if(!this.util.isNull(orderInfo['GET_TICK']))
                        this.util.addAddressTicker(orderInfo['GET_ADDRESS'], orderInfo['GET_TICK']);

                } else {
                    // Instant settlement.
                    //
                    // Two sides settle independently:
                    //   - orderInfo.GIVE → matchInfo.GET_ADDRESS
                    //   - matchInfo.GIVE → orderInfo.GET_ADDRESS
                    //
                    // Token-balance sides follow the existing escrow/credit pattern.
                    // Ownership sides clear the escrow gate and atomically transfer
                    // tokens.owner_id via a synthetic ISSUE+TRANSFER.

                    // orderInfo.GIVE side → matchInfo's proceeds (matchInfo['GET_TICK'], give_amount).
                    // If matchInfo sold a controlled token, its stored royalty/fee split is applied to
                    // these proceeds (seller remainder + leg credits); the escrow release is unchanged
                    // and the split conserves give_amount exactly. applyProceedsSplit returns the lone
                    // full credit when there are no legs, so the call is unconditional.
                    if(Number(orderInfo['GIVE_OWNERSHIP']||0) == 1){
                        await this.util.transferTokenOwnership(this.indexerDb, this.mapper, data, orderInfo['GIVE_TICK'], orderInfo['SOURCE'], matchInfo['GET_ADDRESS']);
                    } else {
                        // Negate in BigNumber space (bcsub), NOT JS unary minus: `-give_amount`
                        // coerces the mathjs BigNumber to an IEEE-754 double, truncating digits
                        // past ~15 sig-figs, so the escrow release would no longer equal the
                        // intact-BigNumber credit below; per-row drift that trips the supply
                        // SanityError on high-decimal ticks.
                        escrows.push([matchInfo['GET_TICK'], this.util.bcsub(0, give_amount, giveDecimals), matchInfo['GET_ADDRESS']]);
                        let mDec = 0;
                        if(!this.util.isNull(matchInfo['PAYOUT_LEGS'])){
                            let mInfo = await this.indexerDb.getTokenInfo(matchInfo['GET_TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX']);
                            mDec = (mInfo && !this.util.isNull(mInfo['DECIMALS'])) ? parseInt(mInfo['DECIMALS']) : 0;
                        }
                        for(let c of this.util.applyProceedsSplit(matchInfo['GET_TICK'], give_amount, matchInfo['GET_ADDRESS'], matchInfo['PAYOUT_LEGS'], mDec, parseInt(this.config['CONTROLLER_MAX_TAKE_BPS']))){
                            credits.push(c);
                            this.util.addAddressTicker(c[2], c[0]);
                        }
                    }

                    // matchInfo.GIVE side → orderInfo's proceeds (orderInfo['GET_TICK'], get_amount).
                    // Same: apply orderInfo's stored split if its sold token was controlled.
                    if(Number(matchInfo['GIVE_OWNERSHIP']||0) == 1){
                        await this.util.transferTokenOwnership(this.indexerDb, this.mapper, data, matchInfo['GIVE_TICK'], matchInfo['SOURCE'], orderInfo['GET_ADDRESS']);
                    } else {
                        // BigNumber-space negation (see the give-side note above).
                        escrows.push([orderInfo['GET_TICK'], this.util.bcsub(0, get_amount, getDecimals), orderInfo['GET_ADDRESS']]);
                        let oDec = 0;
                        if(!this.util.isNull(orderInfo['PAYOUT_LEGS'])){
                            let oInfo = await this.indexerDb.getTokenInfo(orderInfo['GET_TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX']);
                            oDec = (oInfo && !this.util.isNull(oInfo['DECIMALS'])) ? parseInt(oInfo['DECIMALS']) : 0;
                        }
                        for(let c of this.util.applyProceedsSplit(orderInfo['GET_TICK'], get_amount, orderInfo['GET_ADDRESS'], orderInfo['PAYOUT_LEGS'], oDec, parseInt(this.config['CONTROLLER_MAX_TAKE_BPS']))){
                            credits.push(c);
                            this.util.addAddressTicker(c[2], c[0]);
                        }
                    }
                }

                await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits, escrows);

                await this.indexerDb.createOrderMatch(data, orderInfo, matchInfo);

                if(!isNativeCoinMatch){
                    // Handle marking the orders as 'complete' if we have nothing left to give or get (instant settlement only)
                    if(this.util.bclte(order['GET_REMAINING'], 0) || this.util.bclte(order['GIVE_REMAINING'], 0))
                        await this.indexerDb.createOrderStatus(data['ACTION_INDEX'], orderInfo['ACTION_INDEX'], 'complete');
                    if(this.util.bclte(match['GET_REMAINING'], 0) || this.util.bclte(match['GIVE_REMAINING'], 0))
                        await this.indexerDb.createOrderStatus(data['ACTION_INDEX'], matchInfo['ACTION_INDEX'], 'complete');
                }
                // For native coin matches, orders stay 'open' until COINPay fulfills or expires

                await this.mapper.createMappings(action);

                let addresses = Object.keys(this.util.getAddressesList());

                await this.indexerDb.updateBalances(addresses);


            }


        }
    }
}

module.exports = Order_Match;
