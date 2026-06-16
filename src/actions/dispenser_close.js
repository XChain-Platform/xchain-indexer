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

            // Array of credits, debits, and escrows
            let credits = [],
                debits  = [],
                escrows = [];

            // Determine where escrow gets credited. Priority:
            //   1. Sweep destination — if the cancel was driven by a SWEEP, honor the chosen destination.
            //   2. Recorded canceller — per DISPENSER.md, escrow returns to whoever cancelled
            //      (GET_ADDRESS or SOURCE). Recorded by createDispenserStatus when status='cancelling'.
            //   3. SOURCE — fallback for paths with no canceller (auto-expire reaches dispenser_expire,
            //      not here, but covered for safety).
            let sweepDest = await this.indexerDb.getSweepDestination(data['DISPENSER_ACTION_INDEX']);
            let canceller = (!this.util.isNull(sweepDest)) ? null : await this.indexerDb.getDispenserCanceller(data['DISPENSER_ACTION_INDEX']);
            let destination = (!this.util.isNull(sweepDest)) ? sweepDest
                            : (!this.util.isNull(canceller)) ? canceller
                            : dispenser['SOURCE'];

            if(Number(dispenser['GIVE_OWNERSHIP']||0) == 1){
                // Ownership dispenser closure. If the escrow is still set, this is a
                // cancel/expire/sweep path (no successful DISPENSE) — release the gate;
                // if the destination differs from SOURCE, transfer ownership accordingly.
                // If the escrow has already been cleared (because DISPENSE settled and
                // triggered the auto-close), no further action is needed.
                let currentEscrow = await this.indexerDb.getTokenEscrow(dispenser['GIVE_TICK']);
                if(Number(currentEscrow) === Number(dispenser['ACTION_INDEX'])){
                    if(destination == dispenser['SOURCE']){
                        await this.indexerDb.clearTokenEscrow(dispenser['GIVE_TICK']);
                    } else {
                        await this.util.transferTokenOwnership(this.indexerDb, this.mapper, data, dispenser['GIVE_TICK'], dispenser['SOURCE'], destination);
                    }
                }
            } else if(this.util.bcgt(dispenser['GIVE_REMAINING'], 0)){
                escrows.push([dispenser['GIVE_TICK'], -dispenser['GIVE_REMAINING'], destination]);
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