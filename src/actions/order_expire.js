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
 * XChain Platform Action - ORDER_EXPIRE
 * 
 * This action processes orders that have expired
 *
 ********************************************************************/

class Order_Expire {

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

    // Handle expiring a order
    async parse(params, data, error){

        // Get info on the order by action_index. Pass null coin (not the local COIN) so a
        // cross-chain order (get_coin = counterparty chain) is also located on expiry.
        let orderInfo = await this.indexerDb.getOrderInfo(null, data['ACTION_INDEX']);

        // Bail out if order no longer exists (already expired or rolled back)
        if(!orderInfo)
            return;

        // Add SOURCE address and GIVE_TICK to addresses list
        this.util.addAddressTicker(orderInfo['SOURCE'], orderInfo['GIVE_TICK']);

        // Define ORDER_EXPIRE action
        let action = {}
        action['ACTION']      = 'ORDER_EXPIRE';
        action['BLOCK_INDEX'] = data['BLOCK_INDEX'];

        // Create a record of this ORDER_EXPIRE action in the actions table
        data['ACTION_INDEX'] = await this.indexerDb.createActionIndex(action);

        // Set the status to valid
        data['STATUS'] = 'valid';

        // Print status message
        console.log("\t ORDER_EXPIRE : " + this.config['COIN'] + ':' + orderInfo['ACTION_INDEX'] + ' : ' + data['STATUS']);

        // Array of credits, debits, and escrows
        let credits = [],
            debits  = [],
            escrows = [];

        // Check for pending COINPay obligations before expiring
        let pendingObligations = await this.indexerDb.getPendingCoinpayObligationsByOrder(orderInfo['ACTION_INDEX']);

        if(pendingObligations.length > 0){
            // Two-phase expiration: set status to 'expiring' — blocks new matches, pending obligations must resolve first
            // Ownership escrow stays set; coinpay.js releases it when the final obligation resolves.
            await this.indexerDb.createOrderExpire(data['ACTION_INDEX'], orderInfo['ACTION_INDEX'], data['STATUS']);
            await this.indexerDb.createOrderStatus(data['ACTION_INDEX'], orderInfo['ACTION_INDEX'], 'expiring');
        } else {
            // No pending obligations — expire immediately
            if(orderInfo['GIVE_OWNERSHIP']==1){
                // Release ownership escrow back to the seller (tokens.owner_id is unchanged)
                await this.indexerDb.clearTokenEscrow(orderInfo['GIVE_TICK']);
            } else if(!this.util.isNull(orderInfo['GIVE_TICK'])){
                // Debit GIVE_TICK from escrows and credit it to the SOURCE address (skip for native coin GIVE)
                escrows.push([orderInfo['GIVE_TICK'], -orderInfo['GIVE_REMAINING'], orderInfo['SOURCE']]);
                credits.push([orderInfo['GIVE_TICK'],  orderInfo['GIVE_REMAINING'], orderInfo['SOURCE']]);
            }

            // Create record in the order_expires table
            await this.indexerDb.createOrderExpire(data['ACTION_INDEX'], orderInfo['ACTION_INDEX'], data['STATUS']);

            // Create record in the orders_statuses table
            await this.indexerDb.createOrderStatus(data['ACTION_INDEX'], orderInfo['ACTION_INDEX'], 'expired');
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

module.exports = Order_Expire;