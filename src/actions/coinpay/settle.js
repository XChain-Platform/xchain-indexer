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
 * COINPAY settlement parts: the coinpays record, the split of the match's two
 * orders into token seller and coin offerer, the release of the sold token to
 * the buyer, and the completion or finalization of both orders afterwards. The
 * obligation and match status writes stay in coinpay.js settleTrade().
 *
 ********************************************************************/

// Installed onto Coinpay.prototype by coinpay.js; each method runs with `this` bound to
// the handler, exactly as the class method it was.
module.exports = {

    // Record the output this obligation actually settled against. On the legacy path
    // that is the row's own output, unchanged. On the per-payee path the row describes
    // a DIFFERENT address's payment, so recording it would file seller B's settlement
    // under seller A's payment; `coinpays` is a descriptive record (nothing in the
    // indexer reads the table back), so this corrects the attribution without moving a
    // consensus value.
    async recordCoinpay(data, obligationInfo, pool, status){
        let { settledOutput, paidAmount } = pool;

        // Record in the coinpays table
        let coinpayData = {
            ACTION_INDEX:            data['ACTION_INDEX'],
            OBLIGATION_ACTION_INDEX: obligationInfo['ACTION_INDEX'],
            COIN_AMOUNT:             settledOutput ? paidAmount     : data['COIN_AMOUNT'],
            TXID:                    data['TX_HASH'],
            VOUT:                    settledOutput ? settledOutput.vout : data['TX_VOUT'],
            STATUS:                  status,
            BLOCK_INDEX:             data['BLOCK_INDEX']
        };
        await this.indexerDb.createCoinpay(coinpayData);
    },

    // The match's two orders as { sellerOrder, coinOrder }, or null when the match or
    // either order is gone or the native roles are ambiguous (nothing then settles)
    async resolveTradeRoles(data, obligationInfo){
        let matchOrders = await this.indexerDb.getOrderMatchOrders(obligationInfo['ACTION_INDEX']);
        if(!matchOrders)
            return null;

        // Get info on both orders involved in the match
        let giveOrderInfo = await this.indexerDb.getOrderInfo(this.config['COIN'], matchOrders.give_action_index);
        let getOrderInfo  = await this.indexerDb.getOrderInfo(this.config['COIN'], matchOrders.get_action_index);
        if(!giveOrderInfo || !getOrderInfo)
            return null;

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
                getLogger().info("\t COINPAY (skip): ambiguous native roles for match " + obligationInfo['ACTION_INDEX']);
                return null;
            }
        } else if(this.util.isNull(giveOrderInfo['GIVE_TICK']) || giveOrderInfo['GIVE_TICK'] == this.config['COIN']){
            coinOrder   = giveOrderInfo;
            sellerOrder = getOrderInfo;
        } else {
            coinOrder   = getOrderInfo;
            sellerOrder = giveOrderInfo;
        }
        return { sellerOrder, coinOrder };
    },

    // Release the sold token (or its ownership record) to the buyer's GET_ADDRESS
    async releaseSoldToken(data, obligationInfo, sellerOrder, buyerGetAddress, credits, escrows){

        // Token amount released to the buyer: derived from the ORDER_MATCH, not the
        // obligation's coin_amount (a different asset/leg). Whether that is the match's
        // give_amount or its get_amount depends on which side is the seller.
        // give_action_index is the matching order; get_action_index is the original order.
        let matchQuery = await this.indexerDb.getOrderMatchAmounts(obligationInfo['ACTION_INDEX']);
        let tokenAmount;
        if(matchQuery){
            // The match's give_amount or get_amount depends on which side is the seller
            // give_action_index = match order, get_action_index = original order
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
                // BigNumber-space negation, not JS unary minus (float truncation).
                escrows.push([sellerOrder['GIVE_TICK'], this.util.bcsub(0, tokenAmount, 64), sellerOrder['SOURCE']]);
                credits.push([sellerOrder['GIVE_TICK'],  tokenAmount, buyerGetAddress]);
            }
        }
    },

    // Complete either order with nothing left, then finalize a seller left cancelling or
    // expiring once its last pending obligation has resolved
    async finalizeOrders(data, sellerOrder, coinOrder, credits, escrows){

        // Check if orders should be marked 'complete'
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
                        // BigNumber-space negation, not JS unary minus (float truncation).
                        escrows.push([sellerOrder['GIVE_TICK'], this.util.bcsub(0, updatedSellerOrder['GIVE_REMAINING'], 64), sellerOrder['SOURCE']]);
                        credits.push([sellerOrder['GIVE_TICK'],  updatedSellerOrder['GIVE_REMAINING'], refundTo]);
                    }
                }
            }
        }
    }
};
