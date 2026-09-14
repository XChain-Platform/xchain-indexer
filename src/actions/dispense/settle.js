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
 * DISPENSE handler part: SETTLING one dispense.
 *
 * The body of the per-dispense loop: the action index, the status, the dispenses
 * record, the ledger changes, the mappings, and the auto-close that mints a
 * DISPENSER_CLOSE when the dispenser can no longer fill. The caps flag-day the
 * auto-close reads is asked of the handler (dispense.js isDispenseCapsActive) rather
 * than required here, because bin/check-flagday-deploy.sh greps the deployed
 * src/actions/dispense.js for the literal dispenser_caps_activation and an absent
 * marker there reads UNKNOWN rather than failing.
 *
 ********************************************************************/

'use strict';

const { getLogger } = require('../../observability/index.js');

// Installed onto Dispense.prototype by dispense.js; each method runs with `this`
// bound to the handler, exactly as the inline code it was.
module.exports = {

    // One row of the dispenses[] the pricing pass built. The early return skips the rest
    // of this dispense, which is what `continue` does at that point inside a loop.
    async settleDispense(ctx, idx){
    let { data, dispenses, dispenserInfo } = ctx;


            // Reset the address/tickers/transactions list on each parse
            this.util.resetLists();

            // Store info on the dispense and dispenser
            let dispense  = dispenses[idx];
            let dispenser = dispenserInfo[dispense['DISPENSER_ACTION_INDEX']];

            // Defensive: dispenserInfo is only populated for known dispensers (see the
            // 'invalid: Dispenser unknown' skip above). A missing entry here means this
            // dispense has nothing to settle against, so skip it rather than throwing.
            if(!dispenser)
                return;

            // Add Addresses and ticks to the addresses list
            this.util.addAddressTicker(dispense['DESTINATION'], dispenser['GIVE_TICK']);
            this.util.addAddressTicker(dispenser['GET_ADDRESS'],dispenser['GET_TICK']);

            // Set flag to determine if we create new ACTION_INDEX or use existing one
            // Note: Use existing ACTION_INDEX for first DISPSENSE on a native COIN trigger (BTC, LTC. DOGE)
            let createActionIndex = (idx==0 && !this.util.isNull(data['ACTION_INDEX'])) ? false : true;

            // Create a record of this DISPENSE action in the actions table (if it does not already exist)
            dispense['ACTION_INDEX'] = (createActionIndex) ? await this.indexerDb.createActionIndex(data, true) : data['ACTION_INDEX'];

            // Determine final status
            let error  = (dispense['STATUS']) ? dispense['STATUS'] : false;
            let status = (error) ? error : 'valid';
            dispense['STATUS'] = status;

            // Update the in-memory GIVE_REMAINING amount, but only for a VALID dispense.
            // An invalid dispense (e.g. allow/block-list reject) spends no escrow, and the
            // persisted remaining is recomputed from valid dispenses only; decrementing the
            // cached counter for rejected dispenses would let a later reader in this loop
            // see escrow 'spent' by a dispense that never settled.
            if(status=='valid')
                dispenser['GIVE_REMAINING'] = this.util.bcsub(dispenser['GIVE_REMAINING'], dispense['GIVE_AMOUNT'], 64);

            // Print status message
            getLogger().info("\t DISPENSE : " + this.util.logAmount(dispense['GIVE_AMOUNT']) + ' ' + dispenser['GIVE_TICK'] + ' : ' + dispense['STATUS']);

            // Create record in the dispenses table
            await this.indexerDb.createDispense(dispense);
            await this.applyDispenseLedger(ctx, dispense, dispenser, status);
            await this.autoCloseDispenser(ctx, dispense, dispenser, status);
    },

    // The credits, debits and escrow rows a valid dispense moves, then the balance
    // refresh and the action mappings that run whatever the verdict was.
    async applyDispenseLedger(ctx, dispense, dispenser, status){

            // Process the dispense
            if(status=='valid'){

                // Array of credits, debits, and escrows
                let credits = [],
                    debits  = [],
                    escrows = [];

                if(Number(dispenser['GIVE_OWNERSHIP']||0) == 1){
                    // Ownership dispense: clear the escrow gate and atomically transfer
                    // ownership from the dispenser SOURCE to the buyer (data['SOURCE']).
                    await this.util.transferTokenOwnership(this.indexerDb, this.mapper, dispense, dispense['GIVE_TICK'], dispenser['SOURCE'], dispense['DESTINATION']);
                } else if(this.util.bcgt(dispense['GIVE_AMOUNT'], 0)){
                    // Balance dispense: debit from escrow, credit buyer
                    // Negate via bcsub, not JS unary minus: -GIVE_AMOUNT coerces the
                    // 64-precision bignumber string to a float and silently loses digits
                    // past ~15 sig figs, de-syncing the escrow debit from the full-precision
                    // credit below. Mirror the credit exactly at the same precision (64).
                    escrows.push([dispense['GIVE_TICK'], this.util.bcsub(0, dispense['GIVE_AMOUNT'], 64), dispense['DESTINATION']]);
                    credits.push([dispense['GIVE_TICK'],  dispense['GIVE_AMOUNT'], dispense['DESTINATION']]);
                }

                // Process any transaction ledger changes (credits / debits / escrows)
                await this.util.processTransactionLedgerChanges(this.indexerDb, dispense, credits, debits, escrows);

            }

            // Get a list of addresses
            let addresses = Object.keys(this.util.getAddressesList());

            // Update address balances
            await this.indexerDb.updateBalances(addresses);

            // Create action mappings
            await this.mapper.createMappings(dispense);
    },

    // Close the dispenser when it can no longer serve a buyer, or when it has reached
    // the MAX_DISPENSES cap.
    async autoCloseDispenser(ctx, dispense, dispenser, status){
    let { block_index, block_time, tx_index, perUnitClose } = ctx;

            // Close the dispenser when it can no longer serve a buyer. The correct
            // threshold is the dispenser's PER-UNIT price (dispenser GIVE_AMOUNT):
            // close only when remaining escrow cannot cover one more unit. The
            // legacy comparison used the triggering dispense's aggregate
            // give_amount (multiplier * per-unit), closing early after any large
            // order; that behavior is preserved below the gate above so
            // historical blocks replay byte-identically.
            let closeThreshold = perUnitClose ? dispenser['GIVE_AMOUNT'] : dispense['GIVE_AMOUNT'];
            if(status=='valid' && this.util.bclt(dispenser['GIVE_REMAINING'], closeThreshold)){
                let action = 'DISPENSER_CLOSE';
                // cdata, not data: `data` is parse()'s own transaction object, and a local
                // by that name shadows it for the rest of this block, so a later edit
                // reaching for the transaction's SOURCE / FEE_PROBE would silently read the
                // synthetic close payload instead. Matches the MAX_DISPENSES branch below,
                // which already names it this way for the same reason.
                let cdata = {};
                cdata['ACTION']                 = action;
                cdata['BLOCK_INDEX']            = block_index;
                cdata['BLOCK_TIME']             = block_time;
                cdata['TX_INDEX']               = tx_index;
                cdata['DISPENSER_ACTION_INDEX'] = dispenser['ACTION_INDEX'];
                cdata['DISPENSER_STATUS']       = 'empty';
                await this.actions.processAction(action, null, cdata, null);
            } else if(status=='valid' && this.isDispenseCapsActive(block_time)){
                // MAX_DISPENSES cap (see dispenser_caps_activation.js). The dispense
                // that reaches the cap already executed above; now the dispenser auto-closes
                // and refunds remaining escrow to the owner. DISPENSER_CLOSE routes the refund
                // sweep > canceller > SOURCE, which resolves to SOURCE for this auto-close (no
                // sweep, no canceller). The count is derived from valid dispenses since the last
                // refill (a refill resets it), matching Counterparty dispense.py. Gated with the
                // dispenser-family cohort so historical replay stays byte-identical below it.
                let dispenseCount = await this.indexerDb.getDispenserDispenseCount(dispenser['ACTION_INDEX']);
                if(dispenseCount >= this.config['MAX_DISPENSES']){
                    let action = 'DISPENSER_CLOSE';
                    let cdata = {};
                    cdata['ACTION']                 = action;
                    cdata['BLOCK_INDEX']            = block_index;
                    cdata['BLOCK_TIME']             = block_time;
                    cdata['TX_INDEX']               = tx_index;
                    cdata['DISPENSER_ACTION_INDEX'] = dispenser['ACTION_INDEX'];
                    cdata['DISPENSER_STATUS']       = 'max_dispenses_reached';
                    await this.actions.processAction(action, null, cdata, null);
                }
            }
    },
};

