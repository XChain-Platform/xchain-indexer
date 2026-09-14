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
 * DISPENSER_CLOSE settlement: hand the closing dispenser's escrow to its
 * destination (close.js decides where and routes an ownership dispenser),
 * record the close and its status, then post the ledger changes.
 *
 ********************************************************************/

// Installed onto Dispenser_Close.prototype by dispenser_close.js; each method runs with
// `this` bound to the handler, exactly as the class method it was.
module.exports = {

    // Settle the close: escrow to its destination, records, ledger and balances
    async settleClose(data, dispenser){

        // Array of credits, debits, and escrows
        let credits = [],
            debits  = [],
            escrows = [];

        // Where the escrow goes: a SWEEP's destination, then the recorded canceller,
        // then SOURCE (dispenser_close/close.js)
        let { sweepDest, destination } = await this.resolveCloseDestination(data, dispenser);

        if(Number(dispenser['GIVE_OWNERSHIP']||0) == 1){
            // Release the escrow gate or route the ownership record (dispenser_close/close.js)
            await this.closeOwnershipDispenser(data, dispenser, sweepDest, destination);
        } else if(!this.util.isDispenserSettled(dispenser['DISPENSER_STATUS']) &&
                  this.util.bcgt(dispenser['GIVE_REMAINING'], 0)){
            // Gated on the dispenser not having settled already: GIVE_REMAINING is derived and no
            // close/expire reduces it, so a re-settlement would refund it twice
            // (util.isDispenserSettled). Both live entry statuses still refund: 'cancelling' from
            // processCancellations, and 'open' from the dispense.js auto-closes ('empty' and the
            // MAX_DISPENSES cap), which settle a dispenser findMatchingDispensers matched under
            // its own `status IN ('open','cancelling')` filter.
            //
            // Negate via bcsub, not JS unary minus: -GIVE_REMAINING coerces the 64-precision
            // bignumber string to a float and silently loses digits past ~15 sig figs, de-syncing
            // the escrow debit from the full-precision credit below (mirrors dispense.js). Negate
            // at the same precision (64).
            escrows.push([dispenser['GIVE_TICK'], this.util.bcsub(0, dispenser['GIVE_REMAINING'], 64), destination]);
            credits.push([dispenser['GIVE_TICK'],  dispenser['GIVE_REMAINING'], destination]);
        }

        // Add SOURCE and GET_ADDRESS addresses and GET_TICK to addresses list
        this.util.addAddressTicker(dispenser['GET_ADDRESS'], dispenser['GIVE_TICK']);
        this.util.addAddressTicker(destination,              dispenser['GIVE_TICK']);

        // Create record in the dispenser_closes table
        await this.indexerDb.createDispenserClose(data);

        // Create record in the dispenser_statuses table
        await this.indexerDb.createDispenserStatus(data['ACTION_INDEX'], dispenser['ACTION_INDEX'], data['DISPENSER_STATUS']);

        // Process any transaction ledger changes (credits / debits / escrows)
        await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits, escrows);

        // Get a list of addresses
        let addresses = Object.keys(this.util.getAddressesList());

        // Update address balances
        await this.indexerDb.updateBalances(addresses);

        // Create action mappings
        await this.mapper.createMappings(data);
    }
};
