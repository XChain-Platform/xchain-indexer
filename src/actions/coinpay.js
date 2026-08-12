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
 * XChain Platform Action - COINPAY
 *
 * This action processes native coin payments that fulfill COINPay
 * obligations created by ORDER_MATCH for native coin DEX pairs.
 *
 * A COINPAY transaction includes both the action data (OP_RETURN)
 * and a native coin output paying the seller. The indexer processes
 * each output separately; only the output matching the obligation's
 * payee address and amount triggers settlement.
 *
 * Format: COINPAY|0|ORDER_MATCH_ACTION_INDEX
 *
 ********************************************************************/

class Coinpay {

    constructor(action){
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;

        this.formats = {};
        this.formats[0] = 'VERSION|ORDER_MATCH_ACTION_INDEX';
    }

    async parse(params, data, error){

        let format = data['FORMAT'];
        if(!error && (format===null || this.formats[format] === undefined))
            error = 'invalid: VERSION (unknown)';

        if(!error)
            data = this.util.setActionParams(data, params, this.formats, format);

        if(!error)
            data = this.util.setNumberFormats(data);

        let obligationInfo = false;
        if(!error)
            obligationInfo = await this.indexerDb.getCoinpayObligationInfo(data['ORDER_MATCH_ACTION_INDEX']);

        // Each on-chain output is processed independently; only the output that actually
        // matches a pending obligation settles. Every other output early-exits as a no-op.
        if(!obligationInfo || obligationInfo['COINPAY_STATUS'] != 'pending_coinpay'){
            console.log("\t COINPAY (skip): obligation " + data['ORDER_MATCH_ACTION_INDEX'] + " " + (obligationInfo ? "status=" + obligationInfo['COINPAY_STATUS'] : "not found"));
            await this.indexerDb.deleteActionIndex(data['ACTION_INDEX']);
            return;
        }

        if(data['COIN_DESTINATION'] != obligationInfo['PAYEE_ADDRESS']){
            console.log("\t COINPAY (skip): destination mismatch tx=" + data['COIN_DESTINATION'] + " payee=" + obligationInfo['PAYEE_ADDRESS']);
            await this.indexerDb.deleteActionIndex(data['ACTION_INDEX']);
            return;
        }

        if(this.util.bclt(data['COIN_AMOUNT'], obligationInfo['COIN_AMOUNT'])){
            console.log("\t COINPAY (skip): amount short tx=" + data['COIN_AMOUNT'] + " owed=" + obligationInfo['COIN_AMOUNT']);
            await this.indexerDb.deleteActionIndex(data['ACTION_INDEX']);
            return;
        }

        if(!error && data['BLOCK_TIME'] >= obligationInfo['EXPIRATION'])
            error = 'invalid: COINPAY obligation expired';

        let status = (error) ? error : 'valid';
        data['STATUS'] = status;

        console.log("\t COINPAY : " + this.config['COIN'] + ':' + data['ORDER_MATCH_ACTION_INDEX'] + ' : ' + data['STATUS']);

        let coinpayData = {
            ACTION_INDEX:            data['ACTION_INDEX'],
            OBLIGATION_ACTION_INDEX: obligationInfo['ACTION_INDEX'],
            COIN_AMOUNT:             data['COIN_AMOUNT'],
            TXID:                    data['TX_HASH'],
            VOUT:                    data['TX_VOUT'],
            STATUS:                  status,
            BLOCK_INDEX:             data['BLOCK_INDEX']
        };
        await this.indexerDb.createCoinpay(coinpayData);

        if(status != 'valid'){
            await this.mapper.createMappings(data);
            return;
        }

        // Valid COINPAY: settle the trade.
        let matchOrders = await this.indexerDb.getOrderMatchOrders(obligationInfo['ACTION_INDEX']);
        if(!matchOrders)
            return;

        let giveOrderInfo = await this.indexerDb.getOrderInfo(this.config['COIN'], matchOrders.give_action_index);
        let getOrderInfo  = await this.indexerDb.getOrderInfo(this.config['COIN'], matchOrders.get_action_index);
        if(!giveOrderInfo || !getOrderInfo)
            return;

        // Determine which order is the token seller (escrowed tokens) and which is the coin
        // offerer. The role split must match order_match.js (which created the obligation) and
        // coinpay_expire.js (the opposite unwind) exactly, or the wrong order's escrowed token
        // is released. Gated by COINPAY_NATIVE_RECIPROCITY: below the flag-day the legacy
        // single-side check is preserved byte-for-byte; at/after it the split keys on which side
        // actually GIVES native coin, reading BOTH orders. On a well-formed native match exactly
        // one side gives coin, so the two agree; the robust form additionally refuses to settle
        // an ambiguous shape (which order_match no longer creates once the flag is active).
        let sellerOrder, coinOrder;
        if(await this.actions.protocolChanges.isEnabled('COINPAY_NATIVE_RECIPROCITY', data['BLOCK_INDEX'])){
            let giveIsCoin = this.util.isNull(giveOrderInfo['GIVE_TICK']) || giveOrderInfo['GIVE_TICK'] == this.config['COIN'];
            let getIsCoin  = this.util.isNull(getOrderInfo['GIVE_TICK'])  || getOrderInfo['GIVE_TICK']  == this.config['COIN'];
            if(giveIsCoin && !getIsCoin){
                coinOrder   = giveOrderInfo;
                sellerOrder = getOrderInfo;
            } else if(getIsCoin && !giveIsCoin){
                coinOrder   = getOrderInfo;
                sellerOrder = giveOrderInfo;
            } else {
                console.log("\t COINPAY (skip): ambiguous native roles for match " + obligationInfo['ACTION_INDEX']);
                return;
            }
        } else if(this.util.isNull(giveOrderInfo['GIVE_TICK']) || giveOrderInfo['GIVE_TICK'] == this.config['COIN']){
            coinOrder   = giveOrderInfo;
            sellerOrder = getOrderInfo;
        } else {
            coinOrder   = getOrderInfo;
            sellerOrder = giveOrderInfo;
        }

        // The buyer (coin payer) receives tokens at their order's GET_ADDRESS
        let buyerGetAddress = coinOrder['GET_ADDRESS'];

        this.util.addAddressTicker(sellerOrder['SOURCE'], sellerOrder['GIVE_TICK']);
        this.util.addAddressTicker(buyerGetAddress, sellerOrder['GIVE_TICK']);

        let credits = [],
            debits  = [],
            escrows = [];

        // Token amount released to the buyer: derived from the ORDER_MATCH, not the
        // obligation's coin_amount (a different asset/leg). give_action_index is the
        // matching order; get_action_index is the original order.
        let matchQuery = await this.indexerDb.getOrderMatchAmounts(obligationInfo['ACTION_INDEX']);
        let tokenAmount;
        if(matchQuery){
            if(sellerOrder['ACTION_INDEX'] == matchQuery.get_action_index){
                // Seller is the original order (get side): token amount is give_amount
                tokenAmount = matchQuery.give_amount;
            } else {
                // Seller is the match order (give side): token amount is get_amount
                tokenAmount = matchQuery.get_amount;
            }
        }

        if(tokenAmount){
            if(Number(sellerOrder['GIVE_OWNERSHIP']||0) == 1){
                // Ownership delivery: clear the escrow gate and transfer ownership to the
                // buyer's GET_ADDRESS. No balance ledger change (the asset is the ownership
                // record itself).
                await this.util.transferTokenOwnership(this.indexerDb, this.mapper, data, sellerOrder['GIVE_TICK'], sellerOrder['SOURCE'], buyerGetAddress);
            } else {
                // BigNumber-space negation, not JS unary minus (float truncation, #3736).
                escrows.push([sellerOrder['GIVE_TICK'], this.util.bcsub(0, tokenAmount, 64), sellerOrder['SOURCE']]);
                credits.push([sellerOrder['GIVE_TICK'],  tokenAmount, buyerGetAddress]);
            }
        }

        await this.indexerDb.createCoinpayStatus(data['ACTION_INDEX'], obligationInfo['ACTION_INDEX'], 'fulfilled');

        await this.indexerDb.createOrderStatus(data['ACTION_INDEX'], obligationInfo['ACTION_INDEX'], 'valid');

        // Re-fetch order info to get updated GIVE_REMAINING after this settlement
        let updatedSellerOrder = await this.indexerDb.getOrderInfo(this.config['COIN'], sellerOrder['ACTION_INDEX']);
        let updatedCoinOrder   = await this.indexerDb.getOrderInfo(this.config['COIN'], coinOrder['ACTION_INDEX']);

        if(updatedSellerOrder && (this.util.bclte(updatedSellerOrder['GIVE_REMAINING'], 0) || this.util.bclte(updatedSellerOrder['GET_REMAINING'], 0)))
            await this.indexerDb.createOrderStatus(data['ACTION_INDEX'], sellerOrder['ACTION_INDEX'], 'complete');
        if(updatedCoinOrder && (this.util.bclte(updatedCoinOrder['GIVE_REMAINING'], 0) || this.util.bclte(updatedCoinOrder['GET_REMAINING'], 0)))
            await this.indexerDb.createOrderStatus(data['ACTION_INDEX'], coinOrder['ACTION_INDEX'], 'complete');

        // Check if seller's order is in a transitional state and can be finalized
        if(updatedSellerOrder){
            let sellerStatus = updatedSellerOrder['ORDER_STATUS'];
            if(sellerStatus == 'cancelling' || sellerStatus == 'expiring'){
                let pendingObligations = await this.indexerDb.getPendingCoinpayObligationsByOrder(sellerOrder['ACTION_INDEX']);
                if(pendingObligations.length == 0){
                    let finalStatus = (sellerStatus == 'cancelling') ? 'cancelled' : 'expired';
                    await this.indexerDb.createOrderStatus(data['ACTION_INDEX'], sellerOrder['ACTION_INDEX'], finalStatus);

                    // Release any remaining escrowed tokens back to the seller, or to
                    // the SWEEP DESTINATION if the cancelling state was triggered by a
                    // SWEEP with ORDERS=1. Ownership orders are single-fill, so no
                    // remaining balance exists and the escrow gate was already cleared
                    // in the settlement branch above.
                    if(Number(sellerOrder['GIVE_OWNERSHIP']||0) != 1 &&
                       updatedSellerOrder['GIVE_REMAINING'] && this.util.bcgt(updatedSellerOrder['GIVE_REMAINING'], 0)){
                        let refundTo = sellerOrder['SOURCE'];
                        if(sellerStatus == 'cancelling'){
                            let sweepDest = await this.indexerDb.getOrderSweepDestination(sellerOrder['ACTION_INDEX']);
                            if(sweepDest){
                                refundTo = sweepDest;
                                this.util.addAddressTicker(refundTo, sellerOrder['GIVE_TICK']);
                            }
                        }
                        // BigNumber-space negation, not JS unary minus (float truncation, #3736).
                        escrows.push([sellerOrder['GIVE_TICK'], this.util.bcsub(0, updatedSellerOrder['GIVE_REMAINING'], 64), sellerOrder['SOURCE']]);
                        credits.push([sellerOrder['GIVE_TICK'],  updatedSellerOrder['GIVE_REMAINING'], refundTo]);
                    }
                }
            }
        }

        await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits, escrows);

        let tickers   = this.util.getTickersList(),
            addresses = Object.keys(this.util.getAddressesList());

        await this.indexerDb.updateBalances(addresses);
        await this.indexerDb.updateTokens(tickers);

        await this.mapper.createMappings(data);
    }
}

module.exports = Coinpay;
