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
 * XChain Platform Action - SWEEP
 * 
 * This action transfers all `TICK` balances and/or ownerships to a `DESTINATION` address.
 * 
 * PARAMS:
 * - VERSION     - Format Version
 * - DESTINATION - address where `token` shall be swept
 * - BALANCES    - Sweep `TICK` balances to DESTINATION (default=1)
 * - OWNERSHIPS  - Sweep `TICK` ownerships to DESTINATION (default=1)
 * - ORDERS      - Cancel open ORDERs and credit escrow to DESTINATION (default=0)
 * - SWAPS       - Cancel open SWAPs and credit escrow to DESTINATION (default=0)
 * - DISPENSERS  - Close open DISPENSERs and credit escrow to DESTINATION (default=0)
 * - MEMO        - Optional memo to include
 * 
 * FORMATS:
 * - 0 = Full
 * 
 ********************************************************************/

class Sweep {

    // Handle constructing a class instance
    constructor(action){
        // Setup short aliases
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;
        
        // Define list of known FORMATS
        this.formats = {};
        this.formats[0] = 'VERSION|DESTINATION|BALANCES|OWNERSHIPS|ORDERS|SWAPS|DISPENSERS|MEMO';
    }

    // Handle parsing the SWEEP transaction
    async parse(params, data, error){
        /*****************************************************************
         * DEBUGGING - Force params
         ****************************************************************/
        // let str = '0|1BoogrfDADPLQpq8LMASmWQUVYDp4t2hF9|1|1|1|1|1|memo';
        // params = String(str).split('|');
        // data['FORMAT'] = this.util.getFormatVersion(params[0]);

        // Validate that format is known
        let format = data['FORMAT'];
        if(!error && (format===null || this.formats[format] === undefined ))
            error = 'invalid: VERSION (unknown)';

        // Parse PARAMS using given VERSION format and update transaction data object
        if(!error)
            data = this.util.setActionParams(data, params, this.formats, format);

        // Convert NUMBER fields from string value to number value so comparisons are mathematical 
        if(!error)
            data = this.util.setNumberFormats(data);

        // Get source address balances, preferences, and token ownerships
        let balances    = await this.indexerDb.getAddressBalances(data['SOURCE'], null, data['BLOCK_INDEX'], data['ACTION_INDEX']);
        let preferences = await this.indexerDb.getAddressPreferences(data['SOURCE'], data['BLOCK_INDEX'], data['ACTION_INDEX']);
        let ownerships  = await this.indexerDb.getAddressOwnerships(data['SOURCE']);
        let escrowed    = await this.indexerDb.getAddressEscrows(data['SOURCE'], null, data['BLOCK_INDEX'], data['ACTION_INDEX']);

        // Create the fees object 
        let fees = await this.util.createFeesObject(this.indexerDb, data, preferences);

        /*****************************************************************
         * FORMAT Validations
         ****************************************************************/

        // Verify DESTINATION address format
        if(!error && !this.util.isNull(data['DESTINATION']) && !this.util.isCryptoAddress(data['DESTINATION']))
            error = "invalid: DESTINATION (format)";

        // Verify BALANCES format is valid (0 or 1)
        if(!error && !this.util.isNull(data['BALANCES']) && !this.util.isValidValue(data['BALANCES'],[0,1]))
            error = "invalid: BALANCES (format)";

        // Verify OWNERSHIPS format is valid (0 or 1)
        if(!error && !this.util.isNull(data['OWNERSHIPS']) && !this.util.isValidValue(data['OWNERSHIPS'],[0,1]))
            error = "invalid: OWNERSHIP (format)";

        // Verify ORDERS format is valid (0 or 1)
        if(!error && !this.util.isNull(data['ORDERS']) && !this.util.isValidValue(data['ORDERS'],[0,1]))
            error = "invalid: ORDERS (format)";

        // Verify SWAPS format is valid (0 or 1)
        if(!error && !this.util.isNull(data['SWAPS']) && !this.util.isValidValue(data['SWAPS'],[0,1]))
            error = "invalid: SWAPS (format)";

        // Verify DISPENSERS format is valid (0 or 1)
        if(!error && !this.util.isNull(data['DISPENSERS']) && !this.util.isValidValue(data['DISPENSERS'],[0,1]))
            error = "invalid: DISPENSERS (format)";

        // Set default values for BALANCES, OWNERSHIPS, and per-offer-type close flags
        data['BALANCES']   = (!this.util.isNull(data['BALANCES']))   ? data['BALANCES']   : 1;
        data['OWNERSHIPS'] = (!this.util.isNull(data['OWNERSHIPS'])) ? data['OWNERSHIPS'] : 1;
        data['ORDERS']     = (!this.util.isNull(data['ORDERS']))     ? data['ORDERS']     : 0;
        data['SWAPS']      = (!this.util.isNull(data['SWAPS']))      ? data['SWAPS']      : 0;
        data['DISPENSERS'] = (!this.util.isNull(data['DISPENSERS'])) ? data['DISPENSERS'] : 0;

        // Clone the raw data for storage in mints table
        let sweep = Object.assign({}, data);

        /*****************************************************************
         * General Validations
         ****************************************************************/

        // Verify SOURCE is not sleeping
        if(!error && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
            error = 'invalid: SOURCE (sleeping)';

        // Verify no pipe in MEMO (pipe is field delimiter)
        if(!error && !this.util.isNull(data['MEMO']) && String(data['MEMO']).indexOf('|')!=-1)
            error = 'invalid: MEMO (pipe)';

        // Verify no semicolon in MEMO (semicolon is action delimiter)
        if(!error && !this.util.isNull(data['MEMO']) && String(data['MEMO']).indexOf(';')!=-1)
            error = 'invalid: MEMO (semicolon)';

        // Verify MEMO is shorter than MAX_MEMO_LENGTH
        if(!error && String(data['MEMO']).length > this.config['MAX_MEMO_LENGTH'])
            error = 'invalid: MEMO (length)';

        // TODO: Verify sweep is allowed to new address (ALLOW_LIST & BLOCK_LIST)
        // TODO: Verify sweep is allowed on each TICK (SLEEP)

        // Partition escrow rows by type so we can fee + iterate per enabled flag
        let orderEscrows     = (data['ORDERS']     == 1) ? escrowed.filter(e => e.type === 'order')     : [];
        let swapEscrows      = (data['SWAPS']      == 1) ? escrowed.filter(e => e.type === 'swap')      : [];
        let dispenserEscrows = (data['DISPENSERS'] == 1) ? escrowed.filter(e => e.type === 'dispenser') : [];

        // Calculate total number of database hits for this SWEEP
        let db_hits = 1;                                                                                                                            // 1 sweeps
            db_hits += (data['BALANCES'])   ? this.util.bcmul(Object.keys(balances).length,4,0)                                              : 0;   // 1 debits, 1 credits, 2 balances
            db_hits += this.util.bcmul(orderEscrows.length + swapEscrows.length + dispenserEscrows.length, 4, 0);                                   // 1 escrows, 1 credits, 2 balances (per affected offer)
            db_hits += (data['OWNERSHIPS']) ? this.util.bcmul(Object.keys(ownerships).length,2,0)                                            : 0;   // 1 issue, 1 tokens

        // Determine total transaction FEE based on database hits. Emitted (VM-synthesized)
        // actions pay no separate per-tx fee. See util.feeForAction. Without this,
        // getTransactionFee > 0 + detectFeePaymentMode('xchain') rejects every contract-emitted
        // SWEEP as 'insufficient funds (FEE)'.
        fees['AMOUNT'] = this.util.feeForAction(this.util.getTransactionFee(db_hits, fees['TICK']), data);

        // DEBUG
        // console.log('source=',data['SOURCE']);
        // console.log('balances=',balances);
        // console.log('ownerships=',ownerships);
        // console.log('preferences=',preferences);
        // console.log('db_hits=',db_hits);
        // console.log('fees=',fees);

        // Validate fee payment (native coin or XCHAIN balance)
        if(!error && this.util.bcgt(fees['AMOUNT'], 0)){
            let paymentMode = this.util.detectFeePaymentMode(data, this.decoderDb, data['TX_OUTPUTS']);
            if(paymentMode === 'native'){
                let validation = await this.util.validateNativeCoinFee(data, fees, this.indexerDb, data['TX_OUTPUTS']);
                if(!validation.valid){
                    error = 'invalid: ' + (validation.error || 'native coin fee validation failed');
                } else {
                    fees['PAYMENT_MODE']       = 1;
                    fees['NATIVE_COIN_AMOUNT'] = validation.nativeCoinAmount;
                    fees['NATIVE_COIN']        = validation.nativeCoin;
                    fees['ORACLE_ROUND']       = validation.oracleRound;
                }
            } else if(paymentMode === 'rejected'){
                error = 'invalid: insufficient fee (native coin output required)';
            } else {
                if(!this.util.hasBalance(balances, fees['TICK_ID'], fees['AMOUNT']))
                    error = 'invalid: insufficient funds (FEE)';
            }
        }

        // Adjust balances to reduce by FEE AMOUNT (only for XCHAIN deduction mode)
        if(!error && (!fees['PAYMENT_MODE'] || fees['PAYMENT_MODE'] === 2))
            balances = this.util.debitBalances(balances, fees['TICK_ID'], fees['AMOUNT']);

        // Determine final status
        let status = (error) ? error : 'valid';
        data['STATUS'] = sweep['STATUS'] = status;

        // Print status message 
        console.log("\t SWEEP : " + sweep['DESTINATION'] + ' : '+ sweep['STATUS']);

        // Create record in sweeps table
        await this.indexerDb.createSweep(sweep);

        // If this was a valid transaction, then mint any actual supply
        if(status=='valid'){

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

            // Cancel open ORDERs. If the order has pending COINPay obligations, use the
            // two-phase 'cancelling' path (matches order.js v1 cancel behavior): escrow
            // stays locked until obligations resolve via coinpay.js / coinpay_expire.js,
            // which look up db.getOrderSweepDestination() to route residual escrow (or
            // ownership) to this SWEEP's DESTINATION on finalization. Otherwise cancel
            // immediately and route escrow to DESTINATION.
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
                        // Balance order: standard escrow → DESTINATION
                        escrows.push([info['GIVE_TICK'], -info['GIVE_REMAINING'], info['SOURCE']]);
                        credits.push([info['GIVE_TICK'],  info['GIVE_REMAINING'], data['DESTINATION']]);
                        this.util.addAddressTicker(data['DESTINATION'], info['GIVE_TICK']);
                    }
                    await this.indexerDb.createOrderStatus(data['ACTION_INDEX'], info['ACTION_INDEX'], 'cancelled');
                }
            }

            // Cancel open SWAPs and route their escrow to DESTINATION.
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
                    // Balance swap: standard escrow → DESTINATION
                    escrows.push([info['GIVE_TICK'], -info['GIVE_AMOUNT'], info['SOURCE']]);
                    credits.push([info['GIVE_TICK'],  info['GIVE_AMOUNT'], data['DESTINATION']]);
                    this.util.addAddressTicker(data['DESTINATION'], info['GIVE_TICK']);
                }
                await this.indexerDb.createSwapStatus(data['ACTION_INDEX'], info['ACTION_INDEX'], 'cancelled');
            }

            // Close open DISPENSERs. Dispensers close after a set block delay; escrow is
            // routed at close time by dispenser_close, which checks getSweepDestination()
            // and credits the sweep DESTINATION when this status row's action_index ties
            // to a SWEEP action. SOURCE is recorded as the canceller for the non-sweep
            // close paths the spec covers.
            for(let escrow of dispenserEscrows){
                await this.indexerDb.createDispenserStatus(data['ACTION_INDEX'], escrow.action_index, 'cancelling', data['SOURCE']);
            }

            // Ensure SOURCE + DESTINATION are tracked so balance updates run for both
            if(orderEscrows.length || swapEscrows.length || dispenserEscrows.length){
                this.util.addAddressTicker(data['SOURCE']);
                this.util.addAddressTicker(data['DESTINATION']);
            }

            // Transfer any balances
            if(data['BALANCES']==1){
                for(let tick_id in balances){
                    let amount = balances[tick_id];
                    let tick   = await this.indexerDb.getTicker(tick_id);

                    // Debit token amount from SOURCE and credit to DESTINATION
                    debits.push([tick,  amount, data['SOURCE']]);
                    credits.push([tick, amount, data['DESTINATION']]);

                    // Store the SOURCE, DESTINATION and TICK in addresses and tickers lists
                    this.util.addAddressTicker(data['SOURCE'], tick);
                    this.util.addAddressTicker(data['DESTINATION'], tick);
                }
            }

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

            // Transfer token ownerships
            if(data['OWNERSHIPS']==1){
                for(let tick of ownerships){

                    // Ownership already delivered to DESTINATION by the
                    // ORDERS/SWAPS escrow-close path above: never issue a
                    // second transfer for it.
                    if(ownershipsTransferred.has(tick))
                        continue;

                    // Reset the address/tickers/transactions list on each parse
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
                    // console.log('creating issue for tick=',tick);

                    // Store the SOURCE, DESTINATION and TICK in addresses and tickers lists
                    this.util.addAddressTicker(issue['SOURCE'], tick);
                    this.util.addAddressTicker(issue['DESTINATION'], tick);

                    // Create action mappings for this ISSUE
                    await this.mapper.createMappings(issue);


                }
            }

        }
    }
}

module.exports = Sweep;