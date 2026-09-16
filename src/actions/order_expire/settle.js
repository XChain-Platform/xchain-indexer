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
 * ORDER_EXPIRE settlement: an order with pending COINPay obligations moves to
 * 'expiring' and keeps its escrow; one without expires now, handing its GIVE side
 * back to SOURCE. Either way the ledger changes are posted and balances refreshed.
 *
 ********************************************************************/

// Installed onto Order_Expire.prototype by order_expire.js; each method runs with `this`
// bound to the handler, exactly as the class method it was.
module.exports = {

    // Expire the order (or park it as 'expiring') and post the ledger changes
    async settleExpiry(data, orderInfo){

        // Array of credits, debits, and escrows
        let credits = [],
            debits  = [],
            escrows = [];

        // Check for pending COINPay obligations before expiring
        let pendingObligations = await this.indexerDb.getPendingCoinpayObligationsByOrder(orderInfo['ACTION_INDEX']);

        if(pendingObligations.length > 0){
            // Two-phase expiration: set status to 'expiring', which blocks new matches; pending obligations must resolve first.
            // Ownership escrow stays set; coinpay.js releases it when the final obligation resolves.
            await this.indexerDb.createOrderExpire(data['ACTION_INDEX'], orderInfo['ACTION_INDEX'], data['STATUS']);
            await this.indexerDb.createOrderStatus(data['ACTION_INDEX'], orderInfo['ACTION_INDEX'], 'expiring');
        } else {
            // No pending obligations; expire immediately.
            if(orderInfo['GIVE_OWNERSHIP']==1){
                // Release ownership escrow back to the seller (tokens.owner_id is unchanged)
                await this.indexerDb.clearTokenEscrow(orderInfo['GIVE_TICK']);
            } else if(!this.util.isNull(orderInfo['GIVE_TICK'])){
                // Debit GIVE_TICK from escrows and credit it to the SOURCE address (skip for native coin GIVE).
                // Negate in BigNumber space, not JS unary minus: the float round-trip truncates
                // past ~15 sig figs, de-syncing the escrow release from the credit below.
                escrows.push([orderInfo['GIVE_TICK'], this.util.bcsub(0, orderInfo['GIVE_REMAINING'], 64), orderInfo['SOURCE']]);
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
};
