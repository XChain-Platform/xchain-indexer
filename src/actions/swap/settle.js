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
 * SWAP settlement: the final status and its log line, the swaps,
 * swap_cancels and swap_edits rows, and for a valid action the escrow
 * (or ownership escrow) of a create, the release of a cancel, the fee and
 * guard-gas debits, and the ledger and balance updates they drive.
 *
 ********************************************************************/

// Decide the final status, log it, and write the row the action's format calls for.
async function recordSwap(handler, st){
    let { format, data, error, swap, swapInfo } = st;

    // Determine final status
    let status = (error) ? error : 'valid';
    data['STATUS'] = swap['STATUS'] = status;

    // Set SWAP status to 'open' when creating a valid swap
    swap['SWAP_STATUS'] = (status=='valid') ? 'open' : 'invalid';

    // Print status message
    if(format==0)
        getLogger().info("\t SWAP : " + handler.util.logAmount(data['GIVE_AMOUNT']) + ' ' + handler.config['COIN'] + ':' + data['GIVE_TICK'] + ' = '  +  handler.util.logAmount(data['GET_AMOUNT']) + ' ' + data['GET_COIN'] + ':' + data['GET_TICK'] + ' : ' + data['STATUS']);
    if(format==1)
        getLogger().info("\t SWAP_CANCEL : " + handler.config['COIN'] + ':' + data['SWAP_ACTION_INDEX'] + ' : ' + data['STATUS']);
    if(format==2)
        getLogger().info("\t SWAP_EDIT : " + handler.config['COIN'] + ':' + data['SWAP_ACTION_INDEX'] + ' : ' + data['STATUS']);

    // Create record in swaps table
    if(format==0)
        await handler.indexerDb.createSwap(swap);

    // Update action from SWAP to SWAP_CANCEL and create record in swap_cancels table
    if(format==1){
        await handler.indexerDb.updateActionIndex(data['ACTION_INDEX'], 'SWAP_CANCEL');
        await handler.indexerDb.createSwapCancel(swap);
    }

    // Update action from SWAP to SWAP_EDIT and create record in swap_edits table
    if(format==2){
        await handler.indexerDb.updateActionIndex(data['ACTION_INDEX'], 'SWAP_EDIT');
        await handler.indexerDb.createSwapEdit(swap);
    }

    // Store the SOURCE, GIVE_TICK, and GET_TICK in addresses list
    if(format==0){
        handler.util.addAddressTicker(data['SOURCE'], [data['GIVE_TICK'], data['GET_TICK']]);
    } else if(swapInfo) {
        handler.util.addAddressTicker(swapInfo['SOURCE'], [swapInfo['GIVE_TICK'], swapInfo['GET_TICK']]);
    }

    st.status = status;
}

// The escrow a valid create takes, or the release a valid cancel makes, pushed onto the
// ledger change lists the caller settles.
async function escrowOrRelease(handler, st, credits, debits, escrows){
    let { format, data, isOwnershipGive, swapInfo } = st;

    // Format 0 - Create Swap
    if(format==0){
        if(isOwnershipGive){
            // Selling ownership: no balance escrow. Mark the tick as ownership-escrowed
            // for this swap. tokens.owner_id stays at SOURCE; admin actions are gated by
            // escrow_action_index until cancel / expire / match clears it.
            await handler.indexerDb.setTokenEscrow(data['GIVE_TICK'], data['ACTION_INDEX']);
        } else {
            // Debit token from SOURCE
            debits.push([data['GIVE_TICK'], data['GIVE_AMOUNT'], data['SOURCE']]);
            // Escrow token from SOURCE
            escrows.push([data['GIVE_TICK'], data['GIVE_AMOUNT'], data['SOURCE']]);
        }

        // Create record in the swaps_statuses table
        await handler.indexerDb.createSwapStatus(data['ACTION_INDEX'], data['ACTION_INDEX'], 'open');
    }

    // Format 1 - Cancel Swap
    if(format==1){
        if(swapInfo['GIVE_OWNERSHIP']==1){
            // Release ownership escrow back to the seller (tokens.owner_id is unchanged)
            await handler.indexerDb.clearTokenEscrow(swapInfo['GIVE_TICK']);
        } else {
            // Debit token from escrows.
            // BigNumber-space negation, not JS unary minus (float truncation).
            escrows.push([swapInfo['GIVE_TICK'],  handler.util.bcsub(0, swapInfo['GIVE_AMOUNT'], 64),  swapInfo['SOURCE']]);
            // Credit token to SOURCE
            credits.push([swapInfo['GIVE_TICK'], swapInfo['GIVE_AMOUNT'], swapInfo['SOURCE']]);
        }

        await handler.indexerDb.createSwapStatus(data['ACTION_INDEX'], swapInfo['ACTION_INDEX'], 'cancelled');
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

module.exports = { recordSwap, settleLedger };
