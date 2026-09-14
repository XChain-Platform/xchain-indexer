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
 * DISPENSER_EXPIRE settlement: release an ownership dispenser's escrow gate, or
 * refund a balance dispenser's unsettled GIVE_REMAINING to SOURCE, then record the
 * expiry and its status, post the ledger changes and refresh balances.
 *
 ********************************************************************/

// Installed onto Dispenser_Expire.prototype by dispenser_expire.js; each method runs with
// `this` bound to the handler, exactly as the class method it was.
module.exports = {

    // Release or refund the expired dispenser's escrow and post the ledger changes
    async settleExpiry(data, dispenser){

        // Array of credits, debits, and escrows
        let credits = [],
            debits  = [],
            escrows = [];

        if(Number(dispenser['GIVE_OWNERSHIP']||0) == 1){
            // Ownership dispenser expire: release the escrow gate, but only if it is
            // still held by this dispenser. Mirrors dispenser_close.js, which gates
            // the same release on getTokenEscrow(...) === ACTION_INDEX so a stale or
            // already-cleared gate is never touched. tokens.owner_id is unchanged
            // (ownership stays with the seller) on this expiry path.
            let currentEscrow = await this.indexerDb.getTokenEscrow(dispenser['GIVE_TICK']);
            if(Number(currentEscrow) === Number(dispenser['ACTION_INDEX']))
                await this.indexerDb.clearTokenEscrow(dispenser['GIVE_TICK']);
        } else if(!this.util.isDispenserSettled(dispenser['DISPENSER_STATUS']) &&
                  this.util.bcgt(dispenser['GIVE_REMAINING'], 0)){
            // Balance dispenser: debit GIVE_TICK from escrows and credit it to the SOURCE address.
            // Gated on the dispenser not having settled already: GIVE_REMAINING is derived and no
            // close/expire reduces it, so a re-settlement would refund it twice (util.isDispenserSettled).
            // Negate via bcsub, not JS unary minus: -GIVE_REMAINING coerces the 64-precision
            // bignumber string to a float and silently loses digits past ~15 sig figs, de-syncing
            // the escrow debit from the full-precision credit below (mirrors dispense.js). Negate
            // at the same precision (64). Guarded on GIVE_REMAINING > 0, mirroring
            // dispenser_close.js, so an empty balance dispenser does not push a zero-value pair.
            escrows.push([dispenser['GIVE_TICK'], this.util.bcsub(0, dispenser['GIVE_REMAINING'], 64), dispenser['SOURCE']]);
            credits.push([dispenser['GIVE_TICK'],  dispenser['GIVE_REMAINING'], dispenser['SOURCE']]);
        }

        // Create record in the dispenser_expires table
        await this.indexerDb.createDispenserExpire(data['ACTION_INDEX'], dispenser['ACTION_INDEX'], data['STATUS']);

        // Create record in the dispenser_statuses table
        await this.indexerDb.createDispenserStatus(data['ACTION_INDEX'], dispenser['ACTION_INDEX'], 'expired');

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
