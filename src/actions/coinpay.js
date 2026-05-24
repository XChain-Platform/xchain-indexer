/*********************************************************************
 *
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 *
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided "AS IS", without warranties or conditions of any kind.
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
 * each output separately — only the output matching the obligation's
 * payee address and amount triggers settlement.
 *
 * Format: COINPAY|0|ORDER_MATCH_ACTION_INDEX
 *
 ********************************************************************/

class Coinpay {

    // Handle constructing a class instance
    constructor(action){
        // Setup short aliases
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;

        // Define list of known FORMATS
        this.formats = {};
        this.formats[0] = 'VERSION|ORDER_MATCH_ACTION_INDEX';
    }

    // Handle parsing the COINPAY transaction
    async parse(params, data, error){

        // Validate that format is known
        let format = data['FORMAT'];
        if(!error && (format===null || this.formats[format] === undefined))
            error = 'invalid: VERSION (unknown)';

        // Parse PARAMS using given VERSION format and update transaction data object
        if(!error)
            data = this.util.setActionParams(data, params, this.formats, format);

        // Convert NUMBER fields from string value to number value
        if(!error)
            data = this.util.setNumberFormats(data);

        // Look up the COINPay obligation by ORDER_MATCH_ACTION_INDEX
        let obligationInfo = false;
        if(!error)
            obligationInfo = await this.indexerDb.getCoinpayObligationInfo(data['ORDER_MATCH_ACTION_INDEX']);

        // Early exit: if obligation doesn't exist or is not pending, this output is not relevant
        if(!obligationInfo || obligationInfo['COINPAY_STATUS'] != 'pending_coinpay'){
            await this.indexerDb.deleteActionIndex(data['ACTION_INDEX']);
            return;
        }

        // Early exit: if this output's destination doesn't match the payee address
        if(data['COIN_DESTINATION'] != obligationInfo['PAYEE_ADDRESS']){
            await this.indexerDb.deleteActionIndex(data['ACTION_INDEX']);
            return;
        }

        // Early exit: if this output's amount is less than the obligation amount
        if(this.util.bclt(data['COIN_AMOUNT'], obligationInfo['COIN_AMOUNT'])){
            await this.indexerDb.deleteActionIndex(data['ACTION_INDEX']);
            return;
        }

        // Validate obligation has not expired
        if(!error && data['BLOCK_TIME'] >= obligationInfo['EXPIRATION'])
            error = 'invalid: COINPAY obligation expired';

        // Determine final status
        let status = (error) ? error : 'valid';
        data['STATUS'] = status;

        // Print status message
        console.log("\t COINPAY : " + this.config['COIN'] + ':' + data['ORDER_MATCH_ACTION_INDEX'] + ' : ' + data['STATUS']);

        // Record in the coinpays table
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

        // If invalid, record and exit
        if(status != 'valid'){
            await this.mapper.createMappings(data);
            return;
        }

        // ─── Valid COINPAY: Settle the trade ────────────────────────────

        // Get the ORDER_MATCH order action_indexes
        let matchOrders = await this.indexerDb.getOrderMatchOrders(obligationInfo['ACTION_INDEX']);
        if(!matchOrders)
            return;

        // Get info on both orders involved in the match
        let giveOrderInfo = await this.indexerDb.getOrderInfo(this.config['COIN'], matchOrders.give_action_index);
        let getOrderInfo  = await this.indexerDb.getOrderInfo(this.config['COIN'], matchOrders.get_action_index);
        if(!giveOrderInfo || !getOrderInfo)
            return;

        // Determine which order is the token seller (escrowed tokens) and which is the coin offerer
        let sellerOrder, coinOrder;
        if(this.util.isNull(giveOrderInfo['GIVE_TICK']) || giveOrderInfo['GIVE_TICK'] == this.config['COIN']){
            coinOrder   = giveOrderInfo;
            sellerOrder = getOrderInfo;
        } else {
            coinOrder   = getOrderInfo;
            sellerOrder = giveOrderInfo;
        }

        // The buyer (coin payer) receives tokens at their order's GET_ADDRESS
        let buyerGetAddress = coinOrder['GET_ADDRESS'];

        // Add addresses to the addresses list
        this.util.addAddressTicker(sellerOrder['SOURCE'], sellerOrder['GIVE_TICK']);
        this.util.addAddressTicker(buyerGetAddress, sellerOrder['GIVE_TICK']);

        // Array of credits, debits, and escrows
        let credits = [],
            debits  = [],
            escrows = [];

        // Release escrowed tokens to the buyer's GET_ADDRESS
        // The escrowed amount corresponds to the obligation's coin_amount worth of tokens
        // We need to determine the token amount from the ORDER_MATCH
        let matchQuery = await this.indexerDb.getOrderMatchAmounts(obligationInfo['ACTION_INDEX']);
        let tokenAmount;
        if(matchQuery){
            // The match's give_amount or get_amount depends on which side is the seller
            // give_action_index = match order, get_action_index = original order
            if(sellerOrder['ACTION_INDEX'] == matchQuery.get_action_index){
                // Seller is the original order (get side) — token amount is give_amount
                tokenAmount = matchQuery.give_amount;
            } else {
                // Seller is the match order (give side) — token amount is get_amount
                tokenAmount = matchQuery.get_amount;
            }
        }

        if(tokenAmount){
            if(Number(sellerOrder['GIVE_OWNERSHIP']||0) == 1){
                // Ownership delivery: clear the escrow gate and transfer ownership to
                // the buyer's GET_ADDRESS. No balance ledger change — the asset is the
                // ownership record itself.
                await this.util.transferTokenOwnership(this.indexerDb, this.mapper, data, sellerOrder['GIVE_TICK'], sellerOrder['SOURCE'], buyerGetAddress);
            } else {
                escrows.push([sellerOrder['GIVE_TICK'], -tokenAmount, sellerOrder['SOURCE']]);
                credits.push([sellerOrder['GIVE_TICK'],  tokenAmount, buyerGetAddress]);
            }
        }

        // Update coinpay obligation status to 'fulfilled'
        await this.indexerDb.createCoinpayStatus(data['ACTION_INDEX'], obligationInfo['ACTION_INDEX'], 'fulfilled');

        // Update ORDER_MATCH status to 'valid' (settlement complete)
        await this.indexerDb.createOrderStatus(data['ACTION_INDEX'], obligationInfo['ACTION_INDEX'], 'valid');

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

                    // Release any remaining escrowed tokens back to the seller. Ownership
                    // orders are single-fill — there is no remaining balance to refund and
                    // the escrow gate was already cleared in the settlement branch above.
                    if(Number(sellerOrder['GIVE_OWNERSHIP']||0) != 1 &&
                       updatedSellerOrder['GIVE_REMAINING'] && this.util.bcgt(updatedSellerOrder['GIVE_REMAINING'], 0)){
                        escrows.push([sellerOrder['GIVE_TICK'], -updatedSellerOrder['GIVE_REMAINING'], sellerOrder['SOURCE']]);
                        credits.push([sellerOrder['GIVE_TICK'],  updatedSellerOrder['GIVE_REMAINING'], sellerOrder['SOURCE']]);
                    }
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

module.exports = Coinpay;
