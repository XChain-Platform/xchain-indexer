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
 * XChain Platform Action - DISPENSE
 * 
 * This action dispenses tokens from dispensers when they are triggered
  *
 ********************************************************************/

const divergenceMetrics = require('../dispenserDivergenceMetrics.js');
const dispenserCaps = require('../dispenser_caps_activation.js');

class Dispense {

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

    // Handle parsing the DISPENSE transaction
    async parse(params, data, error){

        // Save some details from the dispense request
        let block_index = data['BLOCK_INDEX'];
        let block_time  = data['BLOCK_TIME'];
        let tx_index    = data['TX_INDEX'];

        // Placeholder for valid dispenses
        let dispenses  = [];

        // Placeholder for dispenser info
        let dispenserInfo = {}; 

        // Lookup any dispensers that are triggered by this action
        let action_indexes = await this.indexerDb.findMatchingDispensers(data);

        // If we found no valid dispensers, delete the action_index that we created for this DISPENSE
        if(action_indexes.length==0){
            await this.indexerDb.deleteActionIndex(data['ACTION_INDEX']);

            // Observability: a DISPENSE trigger that matches no open dispenser is dropped.
            // When the paid address DID have a dispenser that is now cancelled or expired,
            // this is the upstream decoder still proposing DISPENSE for a dispenser the
            // indexer already closed/re-dated. Tag the reason and count it so the volume of
            // this split can be sized from logs. Measurement only - the drop above is
            // unchanged; this adds no accept/reject behavior.
            let closed = await this.indexerDb.getClosedDispenserAtAddress(data['COIN'], data['COIN_DESTINATION']);
            if(closed)
                divergenceMetrics.recordRejectedDispense(data['COIN'], block_index, data['COIN_DESTINATION'], closed['ACTION_INDEX'], closed['REASON']);
        }

        // Loop through dispensers and generate a list of valid DISPENSE actions
        // Note: Dispense transactions which do not match an valid dispenser are ignored
        for(let action_index of action_indexes){

            // Reset the error to false for each dispenser
            let error = false;

            // Get full dispenser info including GIVE_REMAINING
            let dispenser = await this.indexerDb.getDispenserInfo(this.config['COIN'], action_index, data['BLOCK_TIME']);

            // Unknown dispenser: no dispenserInfo entry exists to settle against, so
            // skip this action_index entirely rather than pushing a dispense record
            // that references a missing dispenser (no settlement occurs). (#3120: was a
            // sentinel-string round-trip through `error` with two provably-dead !error
            // branches; `error` is false here, so this is behavior-identical.)
            if(!dispenser)
                continue;

            // Store the dispenser info for easy reference
            dispenserInfo[dispenser['ACTION_INDEX']] = dispenser;

            // FIAT dispenser: reverse price match to determine effective GET_AMOUNT
            // Two pricing modes:
            //   - With ORACLE_ADDRESS: use a user oracle (PRICE v1) for TOKEN/FIAT pricing.
            //     The oracle prices the dispensed token directly; FIAT_AMOUNT is ignored.
            //   - Without ORACLE_ADDRESS: use the validator COIN/FIAT snapshot (PRICE v0).
            //     FIAT_AMOUNT defines how much of the FIAT currency 1 GIVE unit costs.
            //
            // FIAT_DISPENSER_PRICING gate (protocol_changes.js). Genesis-active on every
            // network today, so this reads true in production and the reverse-match paths
            // below behave exactly as before. It exists so the settlement path appears in
            // the activation inventory alongside every sibling dispenser rule, and so a
            // future correction to the matching algorithm has a height to hang off. Below
            // activation a FIAT dispenser cannot settle: rejecting is the only well-defined
            // "off" state, because the pre-FIAT code would have divided by the GET_AMOUNT
            // of 0 that FIAT dispensers carry by convention.
            let multiplier = 0;
            let fiatPricingActive = this.util.isNull(dispenser['FIAT'])
                ? true
                : await this.actions.protocolChanges.isEnabled('FIAT_DISPENSER_PRICING', block_index);
            if(!error && !this.util.isNull(dispenser['FIAT']) && !fiatPricingActive){
                error = 'invalid: FIAT dispenser pricing not active';
            } else if(!error && !this.util.isNull(dispenser['FIAT']) && !this.util.isNull(dispenser['ORACLE_ADDRESS'])){
                // User oracle path: combines PEPECASH/JPY (oracle) with BTC/JPY (validator) for cross-conversion
                let priceMatch = await this.util.reverseOraclePriceMatch(
                    data['COIN_AMOUNT'],
                    dispenser['ORACLE_ADDRESS'],
                    dispenser['GIVE_COIN'],
                    dispenser['GIVE_TICK'],
                    dispenser['FIAT'],
                    data['BLOCK_TIME'],
                    this.config['FIAT_DISPENSER_PRICE_WINDOW'],
                    this.indexerDb,
                    // Validator pair is keyed on what the BUYER pays (GET_COIN),
                    // not on the chain of the token being priced (GIVE_COIN above).
                    // Equal today under the same-chain guard; see the note on
                    // reverseOraclePriceMatch.
                    dispenser['GET_COIN']
                );
                if(priceMatch){
                    multiplier = priceMatch.units;
                } else {
                    error = 'invalid: no matching oracle price';
                }
            } else if(!error && !this.util.isNull(dispenser['FIAT'])){
                let coinPair = dispenser['GET_COIN'] + '/' + dispenser['FIAT'];
                let priceMatch = await this.util.reversePriceMatch(
                    data['COIN_AMOUNT'],
                    dispenser['FIAT_AMOUNT'],
                    coinPair,
                    data['BLOCK_TIME'],
                    this.config['FIAT_DISPENSER_PRICE_WINDOW'],
                    this.indexerDb
                );
                if(priceMatch){
                    multiplier = priceMatch.units;
                } else {
                    error = 'invalid: no matching price snapshot';
                }
            }

            // Non-FIAT dispenser: verify COIN_AMOUNT >= GET_AMOUNT and calculate multiplier
            if(!error && this.util.isNull(dispenser['FIAT'])){
                if(this.util.bclt(data['COIN_AMOUNT'], dispenser['GET_AMOUNT']))
                    error = 'invalid: GET_AMOUNT (insufficient funds)';
                if(!error)
                    multiplier = this.util.bcfloor(this.util.bcdiv(data['COIN_AMOUNT'], dispenser['GET_AMOUNT'], 64));
            }

            // Ignore if DISPENSE is being triggered by GET_ADDRESS (dispenser can't trigger itself)
            if(!error && data['SOURCE']==dispenser['GET_ADDRESS'])
                error = 'invalid: SOURCE and GET_ADDRESS can not be same';

            // Ownership dispensers are single-shot: cap multiplier at 1 regardless of overpayment
            // (extra coin is absorbed as a tip, matching the existing overpayment behavior).
            let isOwnershipDispenser = (Number(dispenser['GIVE_OWNERSHIP']||0) == 1);
            if(isOwnershipDispenser && multiplier > 1)
                multiplier = 1;

            // Give out the maximum amount allowed by the dispenser and payment amount:
            // clamp the multiplier to what the dispenser can actually still give.
            //
            // This replaces a decrement loop (multiplier--, with a bignumber multiply
            // per iteration) that was O(multiplier). On a FIAT dispenser the multiplier
            // scales with an externally-chosen price rather than with GET_AMOUNT, so it
            // can be many orders of magnitude larger: a payment worth ~1e7 units against
            // a nearly-empty dispenser spun ten million bignumber multiplies inside one
            // block and could blow BLOCK_PROCESS_TIMEOUT .
            //
            // Identical by construction, not merely equivalent: the loop stopped at the
            // largest m <= multiplier with m * GIVE_AMOUNT <= GIVE_REMAINING, and that is
            // exactly min(multiplier, floor(GIVE_REMAINING / GIVE_AMOUNT)).
            //
            // Two guards keep the rewrite byte-identical on the edges:
            //   - GIVE_AMOUNT is empty/NULL on an ownership dispenser, where bcmul()
            //     coerced it to 0 so `0 > GIVE_REMAINING` was false and the loop never
            //     ran. Skip the clamp there rather than dividing by zero.
            //   - capacity is only computed when the overspill test says the multiplier
            //     does NOT fit, which means capacity < multiplier, and multiplier is
            //     already a safe JS integer. So this bcfloor can never be the one that
            //     overflows.
            let giveAmountIsPositive = !this.util.isNull(dispenser['GIVE_AMOUNT']) &&
                                       this.util.bcgt(dispenser['GIVE_AMOUNT'], '0');
            let give_amount = this.util.bcmul(multiplier, dispenser['GIVE_AMOUNT'], 64);
            if(multiplier > 0 && giveAmountIsPositive &&
               this.util.bcgt(give_amount, dispenser['GIVE_REMAINING'])){
                multiplier  = this.util.bcfloor(
                    this.util.bcdiv(dispenser['GIVE_REMAINING'], dispenser['GIVE_AMOUNT'], 64));
                give_amount = this.util.bcmul(multiplier, dispenser['GIVE_AMOUNT'], 64);
            }

            // Verify that GIVE_AMOUNT 
            if(!error && multiplier == 0)
                error = 'invalid: insufficient funds ';

            // Only create dispensee if we are able to dispense at least 1 GIVE_AMOUNT
            if(!error){

                // Get information on the tokens involved in the dispense
                let getTokenInfo  = await this.indexerDb.getTokenInfo(dispenser['GET_TICK'],  data['BLOCK_INDEX'], data['ACTION_INDEX']);
                let giveTokenInfo = await this.indexerDb.getTokenInfo(dispenser['GIVE_TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX']);

                // List of addresses allowed or blocked from holding GET_TICK
                let getTokenAllowList = (getTokenInfo && !this.util.isNull(getTokenInfo['ALLOW_LIST'])) ? await this.indexerDb.getList(getTokenInfo['ALLOW_LIST'], data['BLOCK_INDEX']) : [];
                let getTokenBlockList = (getTokenInfo && !this.util.isNull(getTokenInfo['BLOCK_LIST'])) ? await this.indexerDb.getList(getTokenInfo['BLOCK_LIST'], data['BLOCK_INDEX']) : [];

                // List of addresses allowed or blocked from holding GIVE_TICK
                let giveTokenAllowList = (giveTokenInfo && !this.util.isNull(giveTokenInfo['ALLOW_LIST'])) ? await this.indexerDb.getList(giveTokenInfo['ALLOW_LIST'], data['BLOCK_INDEX']) : [];
                let giveTokenBlockList = (giveTokenInfo && !this.util.isNull(giveTokenInfo['BLOCK_LIST'])) ? await this.indexerDb.getList(giveTokenInfo['BLOCK_LIST'], data['BLOCK_INDEX']) : [];

                // List of addresses allowed or blocked from matching with this ORDER
                let dispenserAllowList = (!this.util.isNull(dispenser['ALLOW_LIST'])) ? await this.indexerDb.getList(dispenser['ALLOW_LIST'], data['BLOCK_INDEX']) : [];
                let dispenserBlockList = (!this.util.isNull(dispenser['BLOCK_LIST'])) ? await this.indexerDb.getList(dispenser['BLOCK_LIST'], data['BLOCK_INDEX']) : [];

                // Handle validating both sides of dispense are allowed (ALLOW/BLOCK list support)
                if(!error){
                    // Get Token Allow List
                    if(getTokenAllowList.length){
                        if(!error && !getTokenAllowList.includes(data['SOURCE']))
                            error = 'invalid: DESTINATION (GET_TOKEN allow list)';
                        if(!error && !getTokenAllowList.includes(dispenser['GET_ADDRESS']))
                            error = 'invalid: GET_ADDRESS (GET_TOKEN allow list)';
                    }
                    // Get Token Block List
                    if(getTokenBlockList.length){
                        if(!error && getTokenBlockList.includes(data['SOURCE']))
                            error = 'invalid: DESTINATION (GET_TOKEN block list)';
                        if(!error && getTokenBlockList.includes(dispenser['GET_ADDRESS']))
                            error = 'invalid: GET_ADDRESS (GET_TOKEN block list)';
                    }
                    // Give Token Allow List
                    if(giveTokenAllowList.length){
                        if(!error && !giveTokenAllowList.includes(data['SOURCE']))
                            error = 'invalid: DESTINATION (GIVE_TOKEN allow list)';
                        if(!error && !giveTokenAllowList.includes(dispenser['GET_ADDRESS']))
                            error = 'invalid: GET_ADDRESS (GIVE_TOKEN allow list)';
                    }
                    // Give Token Block List
                    if(giveTokenBlockList.length){
                        if(!error && giveTokenBlockList.includes(data['SOURCE']))
                            error = 'invalid: DESTINATION (GIVE_TOKEN block list)';
                        if(!error && giveTokenBlockList.includes(dispenser['GET_ADDRESS']))
                            error = 'invalid: GET_ADDRESS (GIVE_TOKEN block list)';
                    }
                    // Dispenser Allow List
                    if(dispenserAllowList.length){
                        if(!error && !dispenserAllowList.includes(data['SOURCE']))
                            error = 'invalid: DESTINATION (dispenser allow list)';
                        if(!error && !dispenserAllowList.includes(dispenser['GET_ADDRESS']))
                            error = 'invalid: GET_ADDRESS (dispenser allow list)';
                    }
                    // Dispenser Block List
                    if(dispenserBlockList.length){
                        if(!error && dispenserBlockList.includes(data['SOURCE']))
                            error = 'invalid: DESTINATION (DISPENSER block list)';
                        if(!error && dispenserBlockList.includes(dispenser['GET_ADDRESS']))
                            error = 'invalid: GET_ADDRESS (DISPENSER block list)';
                    }
                }
            }

            // Add the dispense info to the dispenses array;
            dispenses.push({
                DISPENSER_ACTION_INDEX: action_index,
                GIVE_COIN:              dispenser['GIVE_COIN'],
                GIVE_TICK:              dispenser['GIVE_TICK'],
                GIVE_AMOUNT:            give_amount,
                GET_COIN:               dispenser['GET_COIN'],
                GET_TICK:               dispenser['GET_TICK'],
                GET_AMOUNT:             data['COIN_AMOUNT'],
                DESTINATION:            data['SOURCE'],
                STATUS:                 error
            });
        }

        //  flag-day: at/above the activation the auto-close threshold is the
        // dispenser's PER-UNIT price; below it the legacy aggregate-purchase
        // comparison applies so historical replay stays byte-identical.
        let perUnitClose = await this.actions.protocolChanges.isEnabled('DISPENSER_CLOSE_PER_UNIT', block_index);

        // Loop through dispenses and process each
        for(let idx in dispenses){

            // Reset the address/tickers/transactions list on each parse
            this.util.resetLists();

            // Store info on the dispense and dispenser
            let dispense  = dispenses[idx];
            let dispenser = dispenserInfo[dispense['DISPENSER_ACTION_INDEX']];

            // Defensive: dispenserInfo is only populated for known dispensers (see the
            // 'invalid: Dispenser unknown' skip above). A missing entry here means this
            // dispense has nothing to settle against, so skip it rather than throwing.
            if(!dispenser)
                continue;

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
            console.log("\t DISPENSE : " + dispense['GIVE_AMOUNT'] + ' ' + dispenser['GIVE_TICK'] + ' : ' + dispense['STATUS']);

            // Create record in the dispenses table
            await this.indexerDb.createDispense(dispense);

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

            // Close the dispenser when it can no longer serve a buyer. The correct
            // threshold is the dispenser's PER-UNIT price (dispenser GIVE_AMOUNT):
            // close only when remaining escrow cannot cover one more unit. The
            // legacy comparison used the triggering dispense's aggregate
            // give_amount (multiplier * per-unit), closing early after any large
            // order; that behavior is preserved below the  flag-day so
            // historical blocks replay byte-identically.
            let closeThreshold = perUnitClose ? dispenser['GIVE_AMOUNT'] : dispense['GIVE_AMOUNT'];
            if(status=='valid' && this.util.bclt(dispenser['GIVE_REMAINING'], closeThreshold)){
                let action = 'DISPENSER_CLOSE';
                let data = {};
                data['ACTION']                 = action;
                data['BLOCK_INDEX']            = block_index;
                data['BLOCK_TIME']             = block_time;
                data['TX_INDEX']               = tx_index;
                data['DISPENSER_ACTION_INDEX'] = dispenser['ACTION_INDEX'];
                data['DISPENSER_STATUS']       = 'empty';
                await this.actions.processAction(action, null, data, null);
            } else if(status=='valid' && dispenserCaps.isDispenserCapsActive(block_time, this.config['NETWORK'])){
                // MAX_DISPENSES cap (dispenser_caps_activation.js / ). The dispense
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
        }
    }
}

module.exports = Dispense;