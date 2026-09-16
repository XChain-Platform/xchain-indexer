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
 * SWEEP settlement: a valid SWEEP bills its fee and guard gas, cancels or
 * closes the SOURCE's open offers the flags select and routes their escrow to
 * DESTINATION, moves every swept balance, posts the ledger, and then deeds
 * each swept ownership to DESTINATION as a transfer ISSUE.
 *
 ********************************************************************/

const gateRegistry = require('../../consensus/gate_registry');

// Installed onto Sweep.prototype by sweep.js; each method runs with `this` bound to
// the handler, exactly as the parse() code it came from.
module.exports = {

    // Settle a valid SWEEP. `state` carries what parse() loaded, priced and guarded.
    async settleSweep(data, sweep, state){
        let { fees, balances, ownerships, guardFee, gasTick } = state;

        // Array of credits and debits
        let credits = [],
            escrows = [],
            debits  = [];

        // Ticks whose ownership the ORDERS/SWAPS loops below deliver to
        // DESTINATION. The OWNERSHIPS loop must never transfer these a
        // second time: escrowed ownership is routed by the offer-close
        // path only (see SWEEP.md), and a duplicate ISSUE would change the
        // per-block actions hash. getAddressOwnerships already excludes
        // escrowed ticks from the snapshot; this set guards the same
        // invariant at the handler level.
        let ownershipsTransferred = new Set();

        // If we are charging a fee, store the SOURCE and fees TICK in addresses list
        if(this.util.bcgt(fees['AMOUNT'], 0))
            this.util.addAddressTicker(data['SOURCE'], fees['TICK']);

        // Handle any transaction FEE according the users's ADDRESS preferences
        [credits, debits] = await this.util.processTransactionFees(this.indexerDb, credits, debits, fees);

        // Bill the cumulative controller-guard gas to SOURCE (a GAS burn with no offsetting
        // credit). `balances` was already reduced above so the swept GAS credited to DESTINATION
        // excludes it; the end-of-action updateTokens recomputes GAS supply from the ledger so the
        // per-block sanityCheck (ledger == supply == balances) holds.
        if(this.util.bcgt(guardFee, 0)){
            debits.push([gasTick, guardFee, data['SOURCE']]);
            this.util.addAddressTicker(data['SOURCE'], gasTick);
        }

        // Close the SOURCE's open offers the flags select, in ORDERS, SWAPS, DISPENSERS order
        await this.cancelSweptOrders(data, state.orderEscrows, credits, escrows, ownershipsTransferred);
        await this.cancelSweptSwaps(data, state.swapEscrows, credits, escrows, ownershipsTransferred);
        await this.closeSweptDispensers(data, state);

        // Transfer any balances
        if(data['BALANCES']==1)
            await this.transferSweptBalances(data, balances, credits, debits, state.resolveTicker);

        // Post the ledger, refresh balances and supply, and map the SWEEP
        await this.postSweepLedger(data, credits, debits, escrows);

        // Transfer token ownerships. Each swept ownership's controller (if any) was already run
        // in the validation-phase `ownership`-class guard loop above; a deny there failed the
        // whole SWEEP before status reached 'valid', so every deed reaching here is authorized.
        if(data['OWNERSHIPS']==1)
            await this.issueSweptOwnerships(sweep, ownerships, ownershipsTransferred);
    },

    // Cancel open ORDERs. If the order has pending COINPay obligations, use the
    // two-phase 'cancelling' path (matches order.js v1 cancel behavior): escrow
    // stays locked until obligations resolve via coinpay.js / coinpay_expire.js,
    // which look up db.getOrderSweepDestination() to route residual escrow (or
    // ownership) to this SWEEP's DESTINATION on finalization. Otherwise cancel
    // immediately and route escrow to DESTINATION.
    async cancelSweptOrders(data, orderEscrows, credits, escrows, ownershipsTransferred){
        for(let escrow of orderEscrows){
            // Null coin: look up by the (local) escrow action_index. SWEEP cancels the
            // SOURCE's open orders whose give-escrow is locked on THIS chain, including
            // cross-chain orders (get_coin = counterparty), which the local-COIN filter
            // would otherwise skip, silently stranding their escrow.
            let info = await this.indexerDb.getOrderInfo(null, escrow.action_index);
            let pendingObligations = await this.indexerDb.getPendingCoinpayObligationsByOrder(info['ACTION_INDEX']);
            if(pendingObligations.length > 0){
                // Defer: let coinpay.js finalize once obligations resolve
                await this.indexerDb.createOrderStatus(data['ACTION_INDEX'], info['ACTION_INDEX'], 'cancelling');
            } else {
                // Immediate cancel: route the escrow to DESTINATION
                if(info['GIVE_OWNERSHIP']==1){
                    // Ownership order: release the escrow gate and atomically transfer
                    // ownership to the sweep DESTINATION.
                    await this.util.transferTokenOwnership(this.indexerDb, this.mapper, data, info['GIVE_TICK'], info['SOURCE'], data['DESTINATION']);
                    ownershipsTransferred.add(info['GIVE_TICK']);
                } else if(!this.util.isNull(info['GIVE_TICK'])){
                    // Balance order: standard escrow → DESTINATION.
                    // BigNumber-space negation, not JS unary minus (float truncation).
                    escrows.push([info['GIVE_TICK'], this.util.bcsub(0, info['GIVE_REMAINING'], 64), info['SOURCE']]);
                    credits.push([info['GIVE_TICK'],  info['GIVE_REMAINING'], data['DESTINATION']]);
                    this.util.addAddressTicker(data['DESTINATION'], info['GIVE_TICK']);
                }
                await this.indexerDb.createOrderStatus(data['ACTION_INDEX'], info['ACTION_INDEX'], 'cancelled');
            }
        }
    },

    // Cancel open SWAPs and route their escrow to DESTINATION.
    async cancelSweptSwaps(data, swapEscrows, credits, escrows, ownershipsTransferred){
        for(let escrow of swapEscrows){
            // Null coin: look up by the (local) escrow action_index so cross-chain swaps
            // (get_coin = counterparty) are swept too, not skipped by the local-COIN filter.
            let info = await this.indexerDb.getSwapInfo(null, escrow.action_index);
            if(info['GIVE_OWNERSHIP']==1){
                // Ownership swap: release the escrow gate and atomically transfer
                // ownership to the sweep DESTINATION.
                await this.util.transferTokenOwnership(this.indexerDb, this.mapper, data, info['GIVE_TICK'], info['SOURCE'], data['DESTINATION']);
                ownershipsTransferred.add(info['GIVE_TICK']);
            } else {
                // Balance swap: standard escrow → DESTINATION.
                // BigNumber-space negation, not JS unary minus (float truncation).
                escrows.push([info['GIVE_TICK'], this.util.bcsub(0, info['GIVE_AMOUNT'], 64), info['SOURCE']]);
                credits.push([info['GIVE_TICK'],  info['GIVE_AMOUNT'], data['DESTINATION']]);
                this.util.addAddressTicker(data['DESTINATION'], info['GIVE_TICK']);
            }
            await this.indexerDb.createSwapStatus(data['ACTION_INDEX'], info['ACTION_INDEX'], 'cancelled');
        }
    },

    // Close open DISPENSERs. Dispensers close after a set block delay; escrow is
    // routed at close time by dispenser_close, which checks getSweepDestination()
    // and credits the sweep DESTINATION when this status row's action_index ties
    // to a SWEEP action. SOURCE is recorded as the canceller for the non-sweep
    // close paths the spec covers.
    async closeSweptDispensers(data, state){
        for(let escrow of state.dispenserEscrows){
            await this.indexerDb.createDispenserStatus(data['ACTION_INDEX'], escrow.action_index, 'cancelling', data['SOURCE']);
        }

        // Ensure SOURCE + DESTINATION are tracked so balance updates run for both
        if(state.orderEscrows.length || state.swapEscrows.length || state.dispenserEscrows.length){
            this.util.addAddressTicker(data['SOURCE']);
            this.util.addAddressTicker(data['DESTINATION']);
        }
    },

    // Move every swept balance from SOURCE to DESTINATION as a debit and a credit
    async transferSweptBalances(data, balances, credits, debits, resolveTicker){
        // Ledger writes follow the SAME consensus-stable order as the controller-guard
        // loop above: byte (binary) order of the RESOLVED tick STRING, never ascending
        // tick_id (a local index_tickers AUTO_INCREMENT surrogate that can diverge across
        // nodes after a reorg, so the credits/debits row ids it produces are node-local).
        // Order-only: the same rows with the same amounts are written either way, and
        // every hashed reader re-sorts on a pinned total order, so no hash moves. It is
        // the WRITE order the guard-loop rationale above says must not follow the
        // surrogate. sweptTicks from that loop is deliberately NOT reused: it is scoped to
        // the validation phase, skips ticks whose ticker does not resolve, and predates the
        // guard-fee debits, so reusing it would change which rows are written.
        let settleTicks = [];
        for(let settleTickId of Object.keys(balances))
            settleTicks.push({ tick_id: settleTickId, tick: await resolveTicker(settleTickId) });
        settleTicks.sort((a, b) => {
            let aKey = Buffer.from(this.util.isNull(a.tick) ? '' : String(a.tick), 'utf8');
            let bKey = Buffer.from(this.util.isNull(b.tick) ? '' : String(b.tick), 'utf8');
            let cmp  = Buffer.compare(aKey, bKey);
            // tick_id tiebreak only keeps the sort a TOTAL order (two entries can tie only
            // on an unresolvable ticker); it never decides the order of resolved ticks.
            return (cmp !== 0) ? cmp : (Number(a.tick_id) - Number(b.tick_id));
        });
        // A held balance can be exactly 0 (a prior sweep already moved it, or the fee
        // debit above reduced it to nothing). Nothing moves for that tick, but the
        // zero-amount debit and credit rows land in the hashed ledger, so skipping
        // them is a flag day (the sweep_zero_leg_activation row): below the height the
        // legs are written as before, at/above it the tick writes no leg.
        let skipZeroLegs = gateRegistry.activeAt('sweep_zero_leg_activation.SWEEP_ZERO_LEG_ACTIVATION', this.config['NETWORK'], data['COIN'], data['BLOCK_INDEX'], null);
        for(let { tick_id, tick } of settleTicks){
            let amount = balances[tick_id];

            if(skipZeroLegs && (this.util.isNull(amount) || !this.util.bcgt(String(amount), '0'))) continue;

            // Debit token amount from SOURCE and credit to DESTINATION
            debits.push([tick,  amount, data['SOURCE']]);
            credits.push([tick, amount, data['DESTINATION']]);

            // Store the SOURCE, DESTINATION and TICK in addresses and tickers lists
            this.util.addAddressTicker(data['SOURCE'], tick);
            this.util.addAddressTicker(data['DESTINATION'], tick);
        }
    },

    // Post the SWEEP's ledger changes, then refresh balances and supply and map the action
    async postSweepLedger(data, credits, debits, escrows){
        // Process any transaction ledger changes (credits / debits)
        await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits, escrows);

        // Get a list of tickers & addresses
        let tickers   = this.util.getTickersList(),
            addresses = Object.keys(this.util.getAddressesList());

        // Update address balances and token supply
        await this.indexerDb.updateBalances(addresses);
        await this.indexerDb.updateTokens(tickers);

        // Create action mappings for this sweep
        await this.mapper.createMappings(data);
    },

    // Deed each swept ownership to DESTINATION as its own transfer ISSUE
    async issueSweptOwnerships(sweep, ownerships, ownershipsTransferred){
        for(let tick of ownerships){

            // Ownership already delivered to DESTINATION by the
            // ORDERS/SWAPS escrow-close path above: never issue a
            // second transfer for it.
            if(ownershipsTransferred.has(tick))
                continue;

            // Reset the address/tickers/transactions list on each parse: each ownership
            // iteration below builds its own ISSUE and must not carry the prior one's lists.
            this.util.resetLists();

            // Copy base transaction data object into issue object
            let issue = sweep;
            issue['ACTION']   = 'ISSUE';
            issue['TICK']     = tick;
            issue['TRANSFER'] = sweep['DESTINATION'];

            // Create a record of this action in the actions table
            issue['ACTION_INDEX'] = await this.indexerDb.createActionIndex(issue, true);

            // Create issue record for transfer of ownership
            await this.indexerDb.createIssue(issue);

            // Update tokens table to indicate new owner
            await this.indexerDb.updateTokens(tick);

            this.util.addAddressTicker(issue['SOURCE'], tick);
            this.util.addAddressTicker(issue['DESTINATION'], tick);

            // Create action mappings for this ISSUE
            await this.mapper.createMappings(issue);
        }
    }
};
