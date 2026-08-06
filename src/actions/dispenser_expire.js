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
 * XChain Platform Action - DISPENSER_EXPIRE
 * 
 * This action processes dispensers that have expired
 *
 ********************************************************************/

class Dispenser_Expire {

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

    // Handle expiring a dispenser
    async parse(params, data, error){

        // Get info on the dispenser
        let dispenser = await this.indexerDb.getDispenserInfo(this.config['COIN'], data['ACTION_INDEX']);

        // Only proceed if we have a valid dispenser
        if(dispenser){

            // Add SOURCE and GET_ADDRESS addresses and GET_TICK to addresses list
            this.util.addAddressTicker(dispenser['SOURCE'],      dispenser['GIVE_TICK']);
            this.util.addAddressTicker(dispenser['GET_ADDRESS'], dispenser['GIVE_TICK']);

            // Define DISPENSER_EXPIRE action
            let action = {}
            action['ACTION']      = 'DISPENSER_EXPIRE';
            action['BLOCK_INDEX'] = data['BLOCK_INDEX'];

            // Create a record of this DISPENSER_EXPIRE action in the actions table
            data['ACTION_INDEX'] = await this.indexerDb.createActionIndex(action);

            // Set the status to valid
            data['STATUS'] = 'valid';

            // Print status message
            console.log("\t DISPENSER_EXPIRE : " + this.config['COIN'] + ':' + dispenser['ACTION_INDEX'] + ' : ' + data['STATUS']);

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
            } else if(this.util.bcgt(dispenser['GIVE_REMAINING'], 0)){
                // Balance dispenser: debit GIVE_TICK from escrows and credit it to the SOURCE address.
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
    }
}

module.exports = Dispenser_Expire;