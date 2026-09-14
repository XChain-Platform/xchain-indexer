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
 * SWAP_MATCH settlement: create the SWAP_MATCH action, settle both GIVE sides
 * (each an ownership transfer or an escrow release split by the seller's stored
 * payout legs), record the match, complete both swaps and refresh balances.
 *
 ********************************************************************/

// Installed onto Swap_Match.prototype by swap_match.js; each method runs with `this`
// bound to the handler, exactly as the class method it was.
module.exports = {

    // Settle a selected match: both GIVE sides move and both swaps complete
    async settleSwapMatch(data, swapInfo, matchInfo){

        // Set the status to valid
        data['STATUS'] = 'valid';

        // Print status message
        getLogger().info("\t SWAP_MATCH : " + this.util.logAmount(swapInfo['GIVE_AMOUNT']) + ' ' + swapInfo['GIVE_COIN'] + ':' + swapInfo['GIVE_TICK'] + ' = '  +  this.util.logAmount(swapInfo['GET_AMOUNT']) + ' ' + swapInfo['GET_COIN'] + ':' + swapInfo['GET_TICK'] + ' : ' + data['STATUS']);

        // Array of credits, debits, and escrows
        let credits = [],
            debits  = [],
            escrows = [];

        // Define SWAP_MATCH action
        let action = {}
        action['ACTION']      = 'SWAP_MATCH';
        action['BLOCK_INDEX'] = data['BLOCK_INDEX'];

        // Create a record of this SWAP_MATCH action in the actions table
        data['ACTION_INDEX'] = await this.indexerDb.createActionIndex(action);

        // Settlement: two sides settle independently:
        //   - swapInfo.GIVE → matchInfo.GET_ADDRESS
        //   - matchInfo.GIVE → swapInfo.GET_ADDRESS
        // Ownership sides clear the escrow gate and atomically transfer ownership;
        // balance sides keep the existing escrow/credit pattern.
        await this.settleSwapGiveSide(data, swapInfo, matchInfo, credits, escrows);
        await this.settleMatchGiveSide(data, swapInfo, matchInfo, credits, escrows);

        // Process any transaction ledger changes (credits / debits / escrows)
        await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits, escrows);

        // Create record of match in swap_matches table
        await this.indexerDb.createSwapMatch(data, swapInfo, matchInfo);

        // Update record in swaps table to change status (open->complete)
        await this.indexerDb.createSwapStatus(data['ACTION_INDEX'], swapInfo['ACTION_INDEX'],  'complete');
        await this.indexerDb.createSwapStatus(data['ACTION_INDEX'], matchInfo['ACTION_INDEX'], 'complete');

        // Get a list of addresses
        let addresses = Object.keys(this.util.getAddressesList());

        // Update address balances
        await this.indexerDb.updateBalances(addresses);

        // Create action mappings
        await this.mapper.createMappings(data);
    },

    // swapInfo.GIVE side → matchInfo's proceeds. If matchInfo sold a controlled token, its
    // stored royalty/fee split applies to these proceeds (applyProceedsSplit returns the
    // lone full credit when there are no legs, so the call is unconditional).
    async settleSwapGiveSide(data, swapInfo, matchInfo, credits, escrows){
        if(Number(swapInfo['GIVE_OWNERSHIP']||0) == 1){
            await this.util.transferTokenOwnership(this.indexerDb, this.mapper, data, swapInfo['GIVE_TICK'], swapInfo['SOURCE'], matchInfo['GET_ADDRESS']);
        } else {
            // Negate via bcsub, not JS unary minus: -GET_AMOUNT coerces the
            // bignumber string to a float and loses digits past ~15 sig figs,
            // de-syncing this escrow debit from the full-precision split credits
            // below (applyProceedsSplit conserves exactly to GET_AMOUNT).
            escrows.push([matchInfo['GET_TICK'], this.util.bcsub(0, matchInfo['GET_AMOUNT'], 64), matchInfo['GET_ADDRESS']]);
            let mDec = 0;
            if(!this.util.isNull(matchInfo['PAYOUT_LEGS'])){
                let mInfo = await this.indexerDb.getTokenInfo(matchInfo['GET_TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX']);
                mDec = (mInfo && !this.util.isNull(mInfo['DECIMALS'])) ? parseInt(mInfo['DECIMALS']) : 0;
            }
            for(let c of this.util.applyProceedsSplit(matchInfo['GET_TICK'], matchInfo['GET_AMOUNT'], matchInfo['GET_ADDRESS'], matchInfo['PAYOUT_LEGS'], mDec, parseInt(this.config['CONTROLLER_MAX_TAKE_BPS']))){
                credits.push(c);
                this.util.addAddressTicker(c[2], c[0]);
            }
        }
    },

    // matchInfo.GIVE side → swapInfo's proceeds. Same: apply swapInfo's stored split.
    async settleMatchGiveSide(data, swapInfo, matchInfo, credits, escrows){
        if(Number(matchInfo['GIVE_OWNERSHIP']||0) == 1){
            await this.util.transferTokenOwnership(this.indexerDb, this.mapper, data, matchInfo['GIVE_TICK'], matchInfo['SOURCE'], swapInfo['GET_ADDRESS']);
        } else {
            // Negate via bcsub, not JS unary minus (see matchInfo side above):
            // preserve full precision so the escrow debit mirrors the split credits.
            escrows.push([swapInfo['GET_TICK'], this.util.bcsub(0, swapInfo['GET_AMOUNT'], 64), swapInfo['GET_ADDRESS']]);
            let sDec = 0;
            if(!this.util.isNull(swapInfo['PAYOUT_LEGS'])){
                let sInfo = await this.indexerDb.getTokenInfo(swapInfo['GET_TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX']);
                sDec = (sInfo && !this.util.isNull(sInfo['DECIMALS'])) ? parseInt(sInfo['DECIMALS']) : 0;
            }
            for(let c of this.util.applyProceedsSplit(swapInfo['GET_TICK'], swapInfo['GET_AMOUNT'], swapInfo['GET_ADDRESS'], swapInfo['PAYOUT_LEGS'], sDec, parseInt(this.config['CONTROLLER_MAX_TAKE_BPS']))){
                credits.push(c);
                this.util.addAddressTicker(c[2], c[0]);
            }
        }
    }
};
