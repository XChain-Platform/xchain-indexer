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
 * XChain Platform Action - DISPENSER_CLOSE
 *
 * This action processes dispensers that need to be closed
 *
 ********************************************************************/

const divergenceMetrics = require('../dispenserDivergenceMetrics.js');
const ownershipCancelGate = require('../dispenser_ownership_cancel_activation.js');

class Dispenser_Close {

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

    // Handle closing a dispenser
    async parse(params, data, error){

        // Get info on the dispenser
        let dispenser = await this.indexerDb.getDispenserInfo(this.config['COIN'], data['DISPENSER_ACTION_INDEX']);

        // Only proceed if we have a valid dispenser
        if(dispenser){


            // Define DISPENSER_CLOSE action
            let action = {}
            action['ACTION']      = 'DISPENSER_CLOSE';
            action['TX_INDEX']    = data['TX_INDEX'];
            action['BLOCK_INDEX'] = data['BLOCK_INDEX'];

            // Create a record of this DISPENSER_CLOSE action in the actions table
            data['ACTION_INDEX'] = await this.indexerDb.createActionIndex(action);

            // Set the status to valid
            data['STATUS'] = 'valid';

            // Print status message
            console.log("\t DISPENSER_CLOSE : " + this.config['COIN'] + ':' + dispenser['ACTION_INDEX'] + ' : ' + data['STATUS']);

            // Observability: a close carrying DISPENSER_STATUS='cancelled' is a
            // cancel (DISPENSER format 1) taking effect. Count it so the volume of
            // cancels the upstream decoder does not mirror can be sized from logs.
            // Measurement only - no state change.
            if(data['DISPENSER_STATUS'] === 'cancelled')
                divergenceMetrics.recordCancel(this.config['COIN'], data['BLOCK_INDEX'], dispenser['ACTION_INDEX'], dispenser['GET_ADDRESS']);

            // Array of credits, debits, and escrows
            let credits = [],
                debits  = [],
                escrows = [];

            // Determine where escrow gets credited. Priority:
            //   1. Sweep destination: if the cancel was driven by a SWEEP, honor the chosen destination.
            //   2. Recorded canceller: per DISPENSER.md, escrow returns to whoever cancelled
            //      (GET_ADDRESS or SOURCE). Recorded by createDispenserStatus when status='cancelling'.
            //   3. SOURCE: fallback for paths with no canceller (auto-expire reaches dispenser_expire,
            //      not here, but covered for safety).
            let sweepDest = await this.indexerDb.getSweepDestination(data['DISPENSER_ACTION_INDEX']);
            let canceller = (!this.util.isNull(sweepDest)) ? null : await this.indexerDb.getDispenserCanceller(data['DISPENSER_ACTION_INDEX']);
            let destination = (!this.util.isNull(sweepDest)) ? sweepDest
                            : (!this.util.isNull(canceller)) ? canceller
                            : dispenser['SOURCE'];

            if(Number(dispenser['GIVE_OWNERSHIP']||0) == 1){
                // Ownership dispenser closure. If the escrow is still set, this is a
                // cancel/expire/sweep path (no successful DISPENSE), so release the gate
                // and route the ownership record. If the escrow has already been cleared
                // (because DISPENSE settled and triggered the auto-close), no action.
                //
                // Ownership routing (DISPENSER.md:122): a cancel or expire returns the
                // token's issuer rights to SOURCE; ONLY a SWEEP-closure delivers them to
                // a non-SOURCE destination. The legacy path transferred to the computed
                // `destination` (sweep > canceller > SOURCE), and cancel authority
                // includes GET_ADDRESS, so a GET_ADDRESS/SOURCE canceller acquired the
                // token's ownership for free (1678). Gated
                // (dispenser_ownership_cancel_activation.js): below the flag-day the
                // legacy canceller-takes-ownership routing runs so historical replay is
                // byte-identical; at/after it only the SWEEP path transfers ownership and
                // cancel/expire leave it with SOURCE (matching dispenser_expire.js, which
                // was already correct). The GIVE token-balance refund routing is separate
                // (handled per DISPENSER cancel semantics) and unaffected here.
                let ownershipCancelActive = ownershipCancelGate.isDispenserOwnershipCancelActive(data['BLOCK_TIME'], this.config['NETWORK']);
                let ownershipDest = ownershipCancelActive
                                  ? ((!this.util.isNull(sweepDest)) ? sweepDest : dispenser['SOURCE'])
                                  : destination;
                let currentEscrow = await this.indexerDb.getTokenEscrow(dispenser['GIVE_TICK']);
                if(Number(currentEscrow) === Number(dispenser['ACTION_INDEX'])){
                    if(ownershipDest == dispenser['SOURCE']){
                        await this.indexerDb.clearTokenEscrow(dispenser['GIVE_TICK']);
                    } else {
                        await this.util.transferTokenOwnership(this.indexerDb, this.mapper, data, dispenser['GIVE_TICK'], dispenser['SOURCE'], ownershipDest);
                    }
                }
            } else if(this.util.bcgt(dispenser['GIVE_REMAINING'], 0)){
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


    }
}

module.exports = Dispenser_Close;