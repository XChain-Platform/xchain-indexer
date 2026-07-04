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
            if(matches.length === 0) matches = false;
        }

        if(matches){

            // Get information on the tokens involved in the order
            let getTokenInfo  = await this.indexerDb.getTokenInfo(orderInfo['GET_TICK'],  data['BLOCK_INDEX'], data['ACTION_INDEX']);
            let giveTokenInfo = await this.indexerDb.getTokenInfo(orderInfo['GIVE_TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX']);

            // List of addresses allowed or blocked from holding GET_TICK
            let getTokenAllowList = (getTokenInfo && !this.util.isNull(getTokenInfo['ALLOW_LIST'])) ? await this.indexerDb.getList(getTokenInfo['ALLOW_LIST']) : [];
            let getTokenBlockList = (getTokenInfo && !this.util.isNull(getTokenInfo['BLOCK_LIST'])) ? await this.indexerDb.getList(getTokenInfo['BLOCK_LIST']) : [];

            // List of addresses allowed or blocked from holding GIVE_TICK
            let giveTokenAllowList = (giveTokenInfo && !this.util.isNull(giveTokenInfo['ALLOW_LIST'])) ? await this.indexerDb.getList(giveTokenInfo['ALLOW_LIST']) : [];
            let giveTokenBlockList = (giveTokenInfo && !this.util.isNull(giveTokenInfo['BLOCK_LIST'])) ? await this.indexerDb.getList(giveTokenInfo['BLOCK_LIST']) : [];

            // List of addresses allowed or blocked from matching with this ORDER
            let orderInfoAllowList = (!this.util.isNull(orderInfo['ALLOW_LIST'])) ? await this.indexerDb.getList(orderInfo['ALLOW_LIST']) : [];
            let orderInfoBlockList = (!this.util.isNull(orderInfo['BLOCK_LIST'])) ? await this.indexerDb.getList(orderInfo['BLOCK_LIST']) : [];

            // Set get/give remaining amounts for this order
            order['GIVE_REMAINING'] = orderInfo['GIVE_REMAINING'];
            order['GET_REMAINING']  = orderInfo['GET_REMAINING'];

            // Loop through matches and determine if we have a valid match
            for(let matchInfo of matches){

                // Reset the address/tickers/transactions list on each match
                this.util.resetLists();

                // Set get/give remaining amounts for this order match
                match['GIVE_REMAINING'] = matchInfo['GIVE_REMAINING'];
                match['GET_REMAINING']  = matchInfo['GET_REMAINING'];

                // Display get/give remaining amounts
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
                // Both orders constrain the trade:
                //   give_amount (orderInfo.GIVE_TICK = matchInfo.GET_TICK) is bounded by
                //     matchInfo.GET_REMAINING and orderInfo.GIVE_REMAINING.
                //   get_amount  (orderInfo.GET_TICK = matchInfo.GIVE_TICK) is bounded by
                //     matchInfo.GIVE_REMAINING and orderInfo.GET_REMAINING.
                // Take whichever pair tightens first as the bottleneck, then derive the
                // other amount from the price. The derived side is multiplied at high
                // precision (64), matching GET_PRICE/GIVE_PRICE's own precision, so the
                // intermediate carries no rounding noise; final quantization happens below.
                let max_give = this.util.bclt(matchInfo['GET_REMAINING'], orderInfo['GIVE_REMAINING'])
                    ? matchInfo['GET_REMAINING']
                    : orderInfo['GIVE_REMAINING'];
                let max_get = this.util.bclt(matchInfo['GIVE_REMAINING'], orderInfo['GET_REMAINING'])
                    ? matchInfo['GIVE_REMAINING']
                    : orderInfo['GET_REMAINING'];
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

                // Snap each settled amount onto its own tick's decimal grid. give_amount is
                // denominated in orderInfo.GIVE_TICK (= matchInfo.GET_TICK), get_amount in
                // orderInfo.GET_TICK (= matchInfo.GIVE_TICK); native-coin sides (null tick,
                // null tokenInfo) use COIN_DECIMALS. This is what enforces indivisibility:
                // a 0-decimal (NFT) tick is forced to integer fills, and any token's fill is
                // freed of sub-unit dust. Each derived amount is <= its side's on-grid max,
                // so rounding can never exceed the escrowed remaining. A fill that rounds to
                // zero is dropped by the guards just below.
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

                // List of addresses allowed or blocked from matching with this matching ORDER
                let matchInfoAllowList = (!this.util.isNull(matchInfo['ALLOW_LIST'])) ? await this.indexerDb.getList(matchInfo['ALLOW_LIST']) : [];
                let matchInfoBlockList = (!this.util.isNull(matchInfo['BLOCK_LIST'])) ? await this.indexerDb.getList(matchInfo['BLOCK_LIST']) : [];

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

                // Update GET_REMAINING and GIVE_REMAINING in the orders
                order['GIVE_REMAINING'] = this.util.bcsub(order['GIVE_REMAINING'], give_amount);
                order['GET_REMAINING']  = this.util.bcsub(order['GET_REMAINING'],  get_amount);
                match['GIVE_REMAINING'] = this.util.bcsub(match['GIVE_REMAINING'], get_amount);
                match['GET_REMAINING']  = this.util.bcsub(match['GET_REMAINING'],  give_amount);

                // Display get/give remaining amounts
                if(this.debug)
                    console.log('FINAL - GET / GIVE remaining=',order['GIVE_REMAINING'],order['GET_REMAINING'])

                // Detect if this is a native coin match (one side has null/empty TICK)
                let isNativeCoinMatch = (this.util.isNull(orderInfo['GIVE_TICK']) ||
                                         this.util.isNull(orderInfo['GET_TICK'])  ||
                                         this.util.isNull(matchInfo['GIVE_TICK']) ||
                                         this.util.isNull(matchInfo['GET_TICK']));

                // Set the status
                data['STATUS'] = isNativeCoinMatch ? 'pending_coinpay' : 'valid';
                data['SETTLEMENT_TYPE'] = isNativeCoinMatch ? 'coinpay' : 'instant';

                // Print status message
                console.log("\t ORDER_MATCH : " + give_amount + ' ' + orderInfo['GIVE_COIN'] + ':' + (orderInfo['GIVE_TICK'] || orderInfo['GIVE_COIN']) + ' = '  + get_amount + ' ' + data['GET_COIN'] + ':' + (data['GET_TICK'] || data['GET_COIN']) + ' : ' + data['STATUS']);

                // Array of credits, debits, and escrows
                let credits = [],
                    debits  = [],
                    escrows = [];

                // Define ORDER_MATCH action
                let action = {}
                action['ACTION']      = 'ORDER_MATCH';
                action['BLOCK_INDEX'] = data['BLOCK_INDEX'];

                // Create a record of this ORDER_MATCH action in the actions table
                action['ACTION_INDEX'] = await this.indexerDb.createActionIndex(action);

                // Update the data object
                data['ACTION_INDEX'] = action['ACTION_INDEX'];
                // Stringify in normal notation here so every downstream consumer
                // (order_matches insert, remaining-amount math, logs) sees the
                // canonical decimal form; a raw bignumber String()s to exponential
                // below 1e-7 ("3e-8") and wedges the state-commitment encoder.
                data['MATCH_GIVE_AMOUNT'] = this.util.bcstr(give_amount);
                data['MATCH_GET_AMOUNT']  = this.util.bcstr(get_amount);

                if(isNativeCoinMatch){
                    // Two-phase settlement: create COINPay obligation
                    // Tokens stay escrowed; no credits/escrow changes until COINPay fulfills or expires

                    // Determine which side is the coin offerer and which is the token seller
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

                    // Create the COINPay obligation
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

                    // Create coinpay obligation status as pending_coinpay
                    await this.indexerDb.createCoinpayStatus(data['ACTION_INDEX'], data['ACTION_INDEX'], 'pending_coinpay');

                    // Store addresses in list for balance/mapping updates
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
                        // SanityError on high-decimal ticks (#3736).
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
                        // BigNumber-space negation (see the give-side note above), #3736.
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

                // Process any transaction ledger changes (credits / debits / escrows)
                await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits, escrows);

                // Create record of match in order_matches table
                await this.indexerDb.createOrderMatch(data, orderInfo, matchInfo);

                if(!isNativeCoinMatch){
                    // Handle marking the orders as 'complete' if we have nothing left to give or get (instant settlement only)
                    if(this.util.bclte(order['GET_REMAINING'], 0) || this.util.bclte(order['GIVE_REMAINING'], 0))
                        await this.indexerDb.createOrderStatus(data['ACTION_INDEX'], orderInfo['ACTION_INDEX'], 'complete');
                    if(this.util.bclte(match['GET_REMAINING'], 0) || this.util.bclte(match['GIVE_REMAINING'], 0))
                        await this.indexerDb.createOrderStatus(data['ACTION_INDEX'], matchInfo['ACTION_INDEX'], 'complete');
                }
                // For native coin matches, orders stay 'open' until COINPay fulfills or expires

                // Create action mappings
                await this.mapper.createMappings(action);

                // Get a list of addresses
                let addresses = Object.keys(this.util.getAddressesList());

                // Update address balances
                await this.indexerDb.updateBalances(addresses);


            }


        }
    }
}

module.exports = Order_Match;