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
 * ORDER_MATCH settlement: book one fill against both running remainders and
 * create its ORDER_MATCH action, then settle it. A native-coin pair opens a
 * COINPay obligation and leaves the tokens escrowed; a token pair settles both
 * GIVE sides at once. Either way the match is recorded, finished orders are
 * completed (instant settlement only) and balances refreshed.
 *
 ********************************************************************/

// Installed onto Order_Match.prototype by order_match.js; each method runs with `this`
// bound to the handler, exactly as the class method it was.
module.exports = {

    // Settle one fill that passed every gate in order_match/match.js
    async settleFill(data, orderInfo, matchInfo, order, match, fill){

        // Book the fill and create its ORDER_MATCH action
        let { action, isNativeCoinMatch } = await this.recordFill(data, orderInfo, matchInfo, order, match, fill);

        // Array of credits, debits, and escrows
        let credits = [],
            debits  = [],
            escrows = [];

        if(isNativeCoinMatch){
            await this.createCoinpayObligation(data, orderInfo, matchInfo, fill);
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
            await this.settleOrderGiveSide(data, orderInfo, matchInfo, fill, credits, escrows);
            await this.settleMatchGiveSide(data, orderInfo, matchInfo, fill, credits, escrows);
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
    },

    // Debit both running remainders, stamp status and settlement type, create the
    // ORDER_MATCH action and carry the matched amounts on `data`. Returns the action and
    // whether the pair settles through a COINPay obligation.
    async recordFill(data, orderInfo, matchInfo, order, match, fill){
        let { give_amount, get_amount } = fill;

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
            getLogger().info('FINAL - GET / GIVE remaining=',order['GIVE_REMAINING'],order['GET_REMAINING'])

        // Detect if this is a native coin match (one side has null/empty TICK)
        let isNativeCoinMatch = (this.util.isNull(orderInfo['GIVE_TICK']) ||
                                 this.util.isNull(orderInfo['GET_TICK'])  ||
                                 this.util.isNull(matchInfo['GIVE_TICK']) ||
                                 this.util.isNull(matchInfo['GET_TICK']));

        // Set the status
        data['STATUS'] = isNativeCoinMatch ? 'pending_coinpay' : 'valid';
        data['SETTLEMENT_TYPE'] = isNativeCoinMatch ? 'coinpay' : 'instant';

        // Print status message
        getLogger().info("\t ORDER_MATCH : " + this.util.logAmount(give_amount) + ' ' + orderInfo['GIVE_COIN'] + ':' + (orderInfo['GIVE_TICK'] || orderInfo['GIVE_COIN']) + ' = '  + this.util.logAmount(get_amount) + ' ' + data['GET_COIN'] + ':' + (data['GET_TICK'] || data['GET_COIN']) + ' : ' + data['STATUS']);

        // Define ORDER_MATCH action
        let action = {}
        action['ACTION']      = 'ORDER_MATCH';
        action['BLOCK_INDEX'] = data['BLOCK_INDEX'];

        // Create a record of this ORDER_MATCH action in the actions table
        action['ACTION_INDEX'] = await this.indexerDb.createActionIndex(action);

        // Update the data object
        data['ACTION_INDEX'] = action['ACTION_INDEX'];
        // Stringify in normal notation here so every downstream consumer (order_matches
        // insert, remaining-amount math, logs) sees the canonical decimal form; a raw
        // bignumber String()s to exponential below 1e-7 ("3e-8") and wedges the
        // state-commitment encoder.
        data['MATCH_GIVE_AMOUNT'] = this.util.bcstr(give_amount);
        data['MATCH_GET_AMOUNT']  = this.util.bcstr(get_amount);

        return { action, isNativeCoinMatch };
    },

    // Two-phase settlement: create COINPay obligation.
    // Tokens stay escrowed; no credits/escrow changes until COINPay fulfills or expires.
    async createCoinpayObligation(data, orderInfo, matchInfo, fill){
        let { give_amount, get_amount } = fill;

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
    },

    // orderInfo.GIVE side → matchInfo's proceeds (matchInfo['GET_TICK'], give_amount).
    // If matchInfo sold a controlled token, its stored royalty/fee split is applied to
    // these proceeds (seller remainder + leg credits); the escrow release is unchanged
    // and the split conserves give_amount exactly. applyProceedsSplit returns the lone
    // full credit when there are no legs, so the call is unconditional.
    async settleOrderGiveSide(data, orderInfo, matchInfo, fill, credits, escrows){
        let { give_amount, giveDecimals } = fill;
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
    },

    // matchInfo.GIVE side → orderInfo's proceeds (orderInfo['GET_TICK'], get_amount).
    // Same: apply orderInfo's stored split if its sold token was controlled.
    async settleMatchGiveSide(data, orderInfo, matchInfo, fill, credits, escrows){
        let { get_amount, getDecimals } = fill;
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
};
