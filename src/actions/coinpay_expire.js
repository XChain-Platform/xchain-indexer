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
 * XChain Platform Action - COINPAY_EXPIRE
 *
 * This action processes COINPay obligations that have expired.
 * When a COINPay obligation expires:
 *   - Escrowed tokens are released back to the seller's order
 *   - The coin-offering party's order is cancelled
 *   - The ORDER_MATCH status is set to 'expired'
 *   - If the seller's order was in 'cancelling' or 'expiring' state
 *     and has no remaining pending obligations, it is finalized
 *
 ********************************************************************/

class Coinpay_Expire {

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

    // Handle expiring a COINPay obligation
    async parse(params, data, error){

        // Get info on the COINPay obligation
        let obligationInfo = await this.indexerDb.getCoinpayObligationInfo(data['ACTION_INDEX']);

        // Bail out if obligation no longer exists (already fulfilled/expired or rolled back)
        if(!obligationInfo)
            return;

        // Get the ORDER_MATCH order action_indexes
        let matchOrders = await this.indexerDb.getOrderMatchOrders(obligationInfo['ACTION_INDEX']);
        if(!matchOrders)
            return;

        // Get info on both orders involved in the match
        // give_action_index = the matching order (counter-party)
        // get_action_index  = the original order
        let giveOrderInfo = await this.indexerDb.getOrderInfo(this.config['COIN'], matchOrders.give_action_index);
        let getOrderInfo  = await this.indexerDb.getOrderInfo(this.config['COIN'], matchOrders.get_action_index);
        if(!giveOrderInfo || !getOrderInfo)
            return;

        // Determine which order is the token seller (has escrowed tokens) and which is the coin
        // offerer. This is the opposite unwind of coinpay.js's fulfill: it MUST identify the
        // seller identically, or the wrong order's escrowed token is released back. Gated by
        // COINPAY_NATIVE_RECIPROCITY: below the flag-day the legacy single-side check (coin
        // offerer = the party whose GIVE_TICK is null/empty) is preserved byte-for-byte; at/after
        // it the split keys on which side actually GIVES native coin, reading BOTH orders, and
        // refuses to settle an ambiguous shape (which order_match no longer creates once active).
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
                console.log("\t COINPAY_EXPIRE (skip): ambiguous native roles for match " + obligationInfo['ACTION_INDEX']);
                return;
            }
        } else if(this.util.isNull(giveOrderInfo['GIVE_TICK']) || giveOrderInfo['GIVE_TICK'] == this.config['COIN']){
            // giveOrder is offering native coin
            coinOrder   = giveOrderInfo;
            sellerOrder = getOrderInfo;
        } else {
            // getOrder is offering native coin
            coinOrder   = getOrderInfo;
            sellerOrder = giveOrderInfo;
        }

        // Determine the SELLER's escrowed token leg for this match. The obligation's
        // COIN_AMOUNT is the BUYER's native-coin leg (a different asset), so releasing
        // it as a token quantity over/under-releases the seller's escrow. Derive the
        // token leg from order_matches exactly as the fulfill path (coinpay.js) does:
        // if the seller is the original (get) order the token side is give_amount, else
        // it is get_amount. Gated by COINPAY_EXPIRE_TOKEN_AMOUNT so the corrected release
        // switches over at a coordinated flag-day; below it the legacy COIN_AMOUNT is
        // preserved byte-for-byte for from-genesis replay and heterogeneous-fleet safety.
        let useTokenAmount = await this.actions.protocolChanges.isEnabled('COINPAY_EXPIRE_TOKEN_AMOUNT', data['BLOCK_INDEX']);
        let releaseAmount  = obligationInfo['COIN_AMOUNT'];
        if(useTokenAmount){
            let matchQuery = await this.indexerDb.getOrderMatchAmounts(obligationInfo['ACTION_INDEX']);
            if(matchQuery){
                releaseAmount = (sellerOrder['ACTION_INDEX'] == matchQuery.get_action_index)
                    ? matchQuery.give_amount
                    : matchQuery.get_amount;
            }
        }

        // Add addresses to the addresses list
        this.util.addAddressTicker(sellerOrder['SOURCE'], sellerOrder['GIVE_TICK']);

        // Define COINPAY_EXPIRE action
        let action = {};
        action['ACTION']      = 'COINPAY_EXPIRE';
        action['BLOCK_INDEX'] = data['BLOCK_INDEX'];

        // Create a record of this COINPAY_EXPIRE action in the actions table
        data['ACTION_INDEX'] = await this.indexerDb.createActionIndex(action);

        // Set the status to valid
        data['STATUS'] = 'valid';

        // Print status message
        console.log("\t COINPAY_EXPIRE : " + this.config['COIN'] + ':' + obligationInfo['ACTION_INDEX'] + ' : ' + data['STATUS']);

        // Array of credits, debits, and escrows
        let credits = [],
            debits  = [],
            escrows = [];

        // If the seller's order was put into 'cancelling' by a SWEEP with ORDERS=1,
        // residual escrow / ownership must route to the sweep's DESTINATION rather
        // than back to the seller. Lookup is a no-op (returns null) for non-sweep
        // cancellations and for orders never sweep-cancelled.
        let sweepDest = (sellerOrder['ORDER_STATUS'] == 'cancelling')
            ? await this.indexerDb.getOrderSweepDestination(sellerOrder['ACTION_INDEX'])
            : null;

        // Release escrowed tokens back to the seller's order, or to the sweep
        // DESTINATION when applicable. For balance orders this restores the seller's
        // GIVE_REMAINING via a ledger credit. For ownership orders there's nothing
        // in the balance ledger: either release the escrow gate back to the seller,
        // or atomically transfer ownership to the sweep DESTINATION.
        if(Number(sellerOrder['GIVE_OWNERSHIP']||0) == 1){
            if(sweepDest){
                await this.util.transferTokenOwnership(this.indexerDb, this.mapper, data, sellerOrder['GIVE_TICK'], sellerOrder['SOURCE'], sweepDest);
            } else {
                await this.indexerDb.clearTokenEscrow(sellerOrder['GIVE_TICK']);
            }
        } else {
            let refundTo = sweepDest || sellerOrder['SOURCE'];
            if(sweepDest) this.util.addAddressTicker(sweepDest, sellerOrder['GIVE_TICK']);
            // BigNumber-space negation, not JS unary minus (float truncation, #3736).
            escrows.push([sellerOrder['GIVE_TICK'], this.util.bcsub(0, releaseAmount, 64), sellerOrder['SOURCE']]);
            credits.push([sellerOrder['GIVE_TICK'],  releaseAmount, refundTo]);
        }

        // Create record in the coinpay_expires table
        await this.indexerDb.createCoinpayExpire(data['ACTION_INDEX'], obligationInfo['ACTION_INDEX'], data['STATUS']);

        // Update coinpay obligation status to 'expired'
        await this.indexerDb.createCoinpayStatus(data['ACTION_INDEX'], obligationInfo['ACTION_INDEX'], 'expired');

        // Update ORDER_MATCH status to 'expired'
        await this.indexerDb.createOrderStatus(data['ACTION_INDEX'], obligationInfo['ACTION_INDEX'], 'expired');

        // The coin-offering party's order stays open; it can match with other sellers.
        // Only the ORDER_MATCH is expired, not the order itself.

        // Check if the seller's order is in a transitional state and can be finalized
        let sellerStatus = sellerOrder['ORDER_STATUS'];
        if(sellerStatus == 'cancelling' || sellerStatus == 'expiring'){
            let pendingObligations = await this.indexerDb.getPendingCoinpayObligationsByOrder(sellerOrder['ACTION_INDEX']);
            if(pendingObligations.length == 0){
                // No more pending obligations. Finalize the seller's order.
                let finalStatus = (sellerStatus == 'cancelling') ? 'cancelled' : 'expired';
                await this.indexerDb.createOrderStatus(data['ACTION_INDEX'], sellerOrder['ACTION_INDEX'], finalStatus);

                // Release any remaining escrowed tokens back to the seller, or to the
                // sweep DESTINATION when finalizing a SWEEP-triggered cancel. Ownership
                // orders are single-fill: no remaining balance, and the gate was already
                // cleared or transferred above.
                if(Number(sellerOrder['GIVE_OWNERSHIP']||0) != 1 &&
                   sellerOrder['GIVE_REMAINING'] && this.util.bcgt(sellerOrder['GIVE_REMAINING'], 0)){
                    let refundTo = sellerOrder['SOURCE'];
                    if(sellerStatus == 'cancelling' && sweepDest){
                        refundTo = sweepDest;
                        this.util.addAddressTicker(refundTo, sellerOrder['GIVE_TICK']);
                    }
                    // BigNumber-space negation, not JS unary minus (float truncation, #3736).
                    escrows.push([sellerOrder['GIVE_TICK'], this.util.bcsub(0, sellerOrder['GIVE_REMAINING'], 64), sellerOrder['SOURCE']]);
                    credits.push([sellerOrder['GIVE_TICK'],  sellerOrder['GIVE_REMAINING'], refundTo]);
                }
            }
        }

        // Process any transaction ledger changes (credits / debits / escrows)
        await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits, escrows);

        // Get a list of tickers & addresses
        let tickers   = this.util.getTickersList(),
            addresses = Object.keys(this.util.getAddressesList());

        // Update address balances and token supply
        await this.indexerDb.updateBalances(addresses);
        await this.indexerDb.updateTokens(tickers);

        // Create action mappings
        await this.mapper.createMappings(data);
    }
}

module.exports = Coinpay_Expire;
