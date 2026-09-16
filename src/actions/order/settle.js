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
 * ORDER settlement: the final status and its log line, the orders,
 * order_cancels and order_edits rows, and for a valid action the escrow
 * (or ownership escrow) of a create, the release or two-phase deferral of
 * a cancel, the fee and guard-gas debits, and the ledger and balance
 * updates they drive.
 *
 ********************************************************************/

// Decide the final status, log it, and write the row the action's format calls for.
async function recordOrder(handler, st){
    let { format, data, error, order, orderInfo } = st;

    // Determine final status
    let status = (error) ? error : 'valid';
    data['STATUS'] = order['STATUS'] = status;

    // Set ORDER status to 'open' when creating a valid order
    order['ORDER_STATUS'] = (status=='valid') ? 'open' : 'invalid';

    // Print status message
    if(format==0)
        getLogger().info("\t ORDER : " + handler.util.logAmount(data['GIVE_AMOUNT']) + ' ' + handler.config['COIN'] + ':' + data['GIVE_TICK'] + ' = '  +  handler.util.logAmount(data['GET_AMOUNT']) + ' ' + data['GET_COIN'] + ':' + data['GET_TICK'] + ' : ' + data['STATUS']);
    if(format==1)
        getLogger().info("\t ORDER_CANCEL : " + handler.config['COIN'] + ':' + data['ORDER_ACTION_INDEX'] + ' : ' + data['STATUS']);
    if(format==2)
        getLogger().info("\t ORDER_EDIT: " + handler.config['COIN'] + ':' + data['ORDER_ACTION_INDEX'] + ' : ' + data['STATUS']);

    // Create record in orders table
    if(format==0)
        await handler.indexerDb.createOrder(order);

    // Update action from ORDER to ORDER_CANCEL and create record in order_cancels table
    if(format==1){
        await handler.indexerDb.updateActionIndex(data['ACTION_INDEX'], 'ORDER_CANCEL');
        await handler.indexerDb.createOrderCancel(order);
    }

    // Update action from ORDER to ORDER_EDIT and create record in order_edits table
    if(format==2){
        await handler.indexerDb.updateActionIndex(data['ACTION_INDEX'], 'ORDER_EDIT');
        await handler.indexerDb.createOrderEdit(order);
    }

    // Store the SOURCE, GIVE_TICK, and GET_TICK in addresses list
    if(format==0){
        handler.util.addAddressTicker(data['SOURCE'], [data['GIVE_TICK'], data['GET_TICK']]);
    } else if(orderInfo) {
        handler.util.addAddressTicker(orderInfo['SOURCE'], [orderInfo['GIVE_TICK'], orderInfo['GET_TICK']]);
    }

    st.status = status;
}

// The escrow a valid create takes, or the release a valid cancel makes, pushed onto the
// ledger change lists the caller settles.
async function escrowOrRelease(handler, st, credits, debits, escrows){
    let { format, data, isNativeCoinGive, isOwnershipGive, orderInfo } = st;

    // Format 0 - Create Order
    if(format==0){
        if(isOwnershipGive){
            // Selling ownership: no balance escrow. Mark the tick as ownership-escrowed
            // for this order. tokens.owner_id stays at SOURCE; admin actions are gated by
            // escrow_action_index until cancel / expire / match clears it.
            await handler.indexerDb.setTokenEscrow(data['GIVE_TICK'], data['ACTION_INDEX']);
        } else if(!isNativeCoinGive){
            // Debit and escrow GIVE_AMOUNT of GIVE_TICK from SOURCE
            debits.push([data['GIVE_TICK'], data['GIVE_AMOUNT'], data['SOURCE']]);
            escrows.push([data['GIVE_TICK'], data['GIVE_AMOUNT'], data['SOURCE']]);
        }
        // (Native coin GIVE: no escrow; obligation created at match time via COINPay)

        // Create record in the orders_statuses table
        await handler.indexerDb.createOrderStatus(data['ACTION_INDEX'], data['ACTION_INDEX'], 'open');
    }

    // Format 1 - Cancel Order
    if(format==1){

        // Check for pending COINPay obligations before cancelling
        let pendingObligations = await handler.indexerDb.getPendingCoinpayObligationsByOrder(orderInfo['ACTION_INDEX']);

        if(pendingObligations.length > 0){
            // Two-phase cancel: set status to 'cancelling'. Blocks new matches; pending obligations must resolve first.
            // Ownership escrow stays set; coinpay.js will release it when the final obligation resolves.
            await handler.indexerDb.createOrderStatus(data['ACTION_INDEX'], orderInfo['ACTION_INDEX'], 'cancelling');
        } else {
            // No pending obligations. Cancel immediately.
            if(orderInfo['GIVE_OWNERSHIP']==1){
                // Release ownership escrow back to the seller (tokens.owner_id is unchanged; only the gate clears)
                await handler.indexerDb.clearTokenEscrow(orderInfo['GIVE_TICK']);
            } else if(!handler.util.isNull(orderInfo['GIVE_TICK'])){
                // Debit token from escrows and credit back to seller. BigNumber-space
                // negation, not JS unary minus: the float round-trip truncates past
                // ~15 sig figs and would de-sync the escrow release from the credit.
                escrows.push([orderInfo['GIVE_TICK'], handler.util.bcsub(0, orderInfo['GIVE_REMAINING'], 64), orderInfo['SOURCE']]);
                credits.push([orderInfo['GIVE_TICK'], orderInfo['GIVE_REMAINING'], orderInfo['SOURCE']]);
            }

            // Create record in the orders_statuses table
            await handler.indexerDb.createOrderStatus(data['ACTION_INDEX'], orderInfo['ACTION_INDEX'], 'cancelled');
        }

    }
}

// Settle a valid action: its escrow or release, the transaction fee, the guard gas, and
// the ledger, balance and token supply updates they drive.
async function settleLedger(handler, st){
    let { data, fees, guardFee, status } = st;

    // Array of credits, debits, and escrows
    let credits = [],
        debits  = [],
        escrows = [];

    // If this was a valid transaction, add GIVE_AMOUNT to escrow
    if(status=='valid'){

        // If we are charging a fee, store the SOURCE and fees TICK in addresses list
        if(handler.util.bcgt(fees['AMOUNT'], 0))
            handler.util.addAddressTicker(data['SOURCE'], fees['TICK']);

        // Take the create's escrow or make the cancel's release
        await escrowOrRelease(handler, st, credits, debits, escrows);

        // Handle any transaction FEE according the users's ADDRESS preferences
        [credits, debits] = await handler.util.processTransactionFees(handler.indexerDb, credits, debits, fees);

        // Bill the controller-guard gas to SOURCE (in GAS), reserved above.
        if(handler.util.bcgt(guardFee, 0)){
            debits.push([handler.config['GAS'], guardFee, data['SOURCE']]);
            handler.util.addAddressTicker(data['SOURCE'], handler.config['GAS']);
        }

        // Process any transaction ledger changes (credits / debits / escrows)
        await handler.util.processTransactionLedgerChanges(handler.indexerDb, data, credits, debits, escrows);

        // Get a list of tickers & addresses
        let tickers   = handler.util.getTickersList(),
            addresses = Object.keys(handler.util.getAddressesList());

        // Update address balances and token supply
        await handler.indexerDb.updateBalances(addresses);
        await handler.indexerDb.updateTokens(tickers);

    }
}

module.exports = { recordOrder, settleLedger };
