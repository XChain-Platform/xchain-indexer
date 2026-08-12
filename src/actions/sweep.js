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

    constructor(action){
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;

        this.formats = {};
        this.formats[0] = 'VERSION|DESTINATION|BALANCES|OWNERSHIPS|ORDERS|SWAPS|DISPENSERS|MEMO';
    }

    async parse(params, data, error){
        let format = data['FORMAT'];
        if(!error && (format===null || this.formats[format] === undefined ))
            error = 'invalid: VERSION (unknown)';

        if(!error)
            data = this.util.setActionParams(data, params, this.formats, format);

        // Convert NUMBER fields from string to number so comparisons below are mathematical, not lexical.
        if(!error)
            data = this.util.setNumberFormats(data);

        // Resolve a compacted ^<id> DESTINATION back to its canonical address before
        // validation/use (see resolveAddressRefChecked). At/after the reference-resolution
        // flag-day an unresolvable reference is a hard reject; below it the value is left
        // as-is and rejected by isCryptoAddress.
        if(!error){
            let destRef = await this.indexerDb.resolveAddressRefChecked(data['DESTINATION'], data['BLOCK_INDEX']);
            data['DESTINATION'] = destRef.value;
            if(destRef.rejected)
                error = 'invalid: DESTINATION (unresolvable ^id)';
        }

        let balances    = await this.indexerDb.getAddressBalances(data['SOURCE'], null, data['BLOCK_INDEX'], data['ACTION_INDEX']);
        let preferences = await this.indexerDb.getAddressPreferences(data['SOURCE'], data['BLOCK_INDEX'], data['ACTION_INDEX']);
        let ownerships  = await this.indexerDb.getAddressOwnerships(data['SOURCE']);
        let escrowed    = await this.indexerDb.getAddressEscrows(data['SOURCE'], null, data['BLOCK_INDEX'], data['ACTION_INDEX']);

        let fees = await this.util.createFeesObject(this.indexerDb, data, preferences);

        // Per-run memo for tick_id -> ticker resolution. SWEEP resolves the same set of held
        // tick_ids twice (the BALANCES controller-guard loop below and the settlement balance-
        // transfer loop), one getTicker query per ticker each pass. tick_id -> ticker is
        // immutable within a block, so cache the first lookup and reuse it across both passes:
        // O(distinct held ticks) queries instead of 2x. Read-only, so it changes only how many
        // queries run, never which ticker a tick_id resolves to.
        let tickerCache = {};
        let resolveTicker = async (tickId) => {
            let key = Number(tickId);
            if(tickerCache[key] === undefined)
                tickerCache[key] = await this.indexerDb.getTicker(key);
            return tickerCache[key];
        };

        // Controller-bound token gas context. Any swept balance of a token whose `transfer` class is
        // bound to a controller runs that contract's `guard` before the sweep settles; SOURCE pays
        // the (bounded) cumulative guard gas in GAS. Loaded once; the per-tick guard loop below
        // reserves against the live `balances` view and any deny fails the whole SWEEP. Pre-flag-day
        // the guard is a strict no-op.
        let gasTick  = this.config['GAS'];
        let gasInfo  = await this.indexerDb.getTokenInfo(gasTick, data['BLOCK_INDEX'], data['ACTION_INDEX']);
        let guardFee = 0;

        // DESTINATION is mandatory. A null/empty DESTINATION skips the format check below and
        // sweeps every SOURCE balance into a NULL-address credit: createLedgerChangeRecord writes
        // the credit with address_id=NULL, but updateBalances skips NULL addresses, so SOURCE's
        // balances row is decremented with no matching credit row - the balances sum falls short
        // of the unchanged token supply and the per-block sanityCheck throws SanityError, halting
        // the indexer fleet-wide from one crafted tx (and OWNERSHIPS=1 would also deed ownership to
        // a NULL owner). Reject it up front. Ungated: current behaviour is a chain HALT (no block
        // commits), so there is no committed valid ledger for this to fork against.
        if(!error && this.util.isNull(data['DESTINATION']))
            error = "invalid: DESTINATION (null)";

        if(!error && !this.util.isNull(data['DESTINATION']) && !this.util.isCryptoAddress(data['DESTINATION']))
            error = "invalid: DESTINATION (format)";

        if(!error && !this.util.isNull(data['BALANCES']) && !this.util.isValidValue(data['BALANCES'],[0,1]))
            error = "invalid: BALANCES (format)";

        if(!error && !this.util.isNull(data['OWNERSHIPS']) && !this.util.isValidValue(data['OWNERSHIPS'],[0,1]))
            error = "invalid: OWNERSHIP (format)";

        if(!error && !this.util.isNull(data['ORDERS']) && !this.util.isValidValue(data['ORDERS'],[0,1]))
            error = "invalid: ORDERS (format)";

        if(!error && !this.util.isNull(data['SWAPS']) && !this.util.isValidValue(data['SWAPS'],[0,1]))
            error = "invalid: SWAPS (format)";

        if(!error && !this.util.isNull(data['DISPENSERS']) && !this.util.isValidValue(data['DISPENSERS'],[0,1]))
            error = "invalid: DISPENSERS (format)";

        data['BALANCES']   = (!this.util.isNull(data['BALANCES']))   ? data['BALANCES']   : 1;
        data['OWNERSHIPS'] = (!this.util.isNull(data['OWNERSHIPS'])) ? data['OWNERSHIPS'] : 1;
        data['ORDERS']     = (!this.util.isNull(data['ORDERS']))     ? data['ORDERS']     : 0;
        data['SWAPS']      = (!this.util.isNull(data['SWAPS']))      ? data['SWAPS']      : 0;
        data['DISPENSERS'] = (!this.util.isNull(data['DISPENSERS'])) ? data['DISPENSERS'] : 0;

        // Clone the raw data for storage in the sweeps table.
        let sweep = Object.assign({}, data);

        if(!error && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
            error = 'invalid: SOURCE (sleeping)';

        // Verify no pipe in MEMO (pipe is field delimiter)
        if(!error && !this.util.isNull(data['MEMO']) && String(data['MEMO']).indexOf('|')!=-1)
            error = 'invalid: MEMO (pipe)';

        // Verify no semicolon in MEMO (semicolon is action delimiter)
        if(!error && !this.util.isNull(data['MEMO']) && String(data['MEMO']).indexOf(';')!=-1)
            error = 'invalid: MEMO (semicolon)';

        if(!error && String(data['MEMO']).length > this.config['MAX_MEMO_LENGTH'])
            error = 'invalid: MEMO (length)';

        // TODO: Verify sweep is allowed to new address (ALLOW_LIST & BLOCK_LIST)
        // TODO: Verify sweep is allowed on each TICK (SLEEP)

        // Partition escrow rows by type so we can fee + iterate per enabled flag
        let orderEscrows     = (data['ORDERS']     == 1) ? escrowed.filter(e => e.type === 'order')     : [];
        let swapEscrows      = (data['SWAPS']      == 1) ? escrowed.filter(e => e.type === 'swap')      : [];
        let dispenserEscrows = (data['DISPENSERS'] == 1) ? escrowed.filter(e => e.type === 'dispenser') : [];

        // Calculate total number of database hits for this SWEEP. LEGACY_FEE_NUMERIC_DBHITS
        // gates the db_hits string-concatenation fix: below the flag-day reproduce the
        // original `+= bcmul(...)` concatenation byte-for-byte. The escrow term has no ternary
        // guard, so even a zero-escrow SWEEP concatenated "0" onto db_hits (1 -> "10" -> "100")
        // and inflated the fee; the below-flag path preserves that so a pre-activation replay
        // commits the identical fee. At/above the flag-day accumulate numerically. See
        // protocol_changes.js.
        let numericDbHits = await this.actions.protocolChanges.isEnabled('LEGACY_FEE_NUMERIC_DBHITS', data['BLOCK_INDEX']);
        let db_hits = 1;                                                                                                                            // 1 sweeps
        if(numericDbHits){
            db_hits += (data['BALANCES'])   ? Number(Object.keys(balances).length) * 4                                                       : 0;   // 1 debits, 1 credits, 2 balances
            db_hits += Number(orderEscrows.length + swapEscrows.length + dispenserEscrows.length) * 4;                                              // 1 escrows, 1 credits, 2 balances (per affected offer)
            db_hits += (data['OWNERSHIPS']) ? Number(Object.keys(ownerships).length) * 2                                                     : 0;   // 1 issue, 1 tokens
        } else {
            db_hits += (data['BALANCES'])   ? this.util.bcmul(Object.keys(balances).length, 4, 0)                                            : 0;   // 1 debits, 1 credits, 2 balances
            db_hits += this.util.bcmul(orderEscrows.length + swapEscrows.length + dispenserEscrows.length, 4, 0);                                   // 1 escrows, 1 credits, 2 balances (per affected offer)
            db_hits += (data['OWNERSHIPS']) ? this.util.bcmul(Object.keys(ownerships).length, 2, 0)                                          : 0;   // 1 issue, 1 tokens
        }

        // Determine total transaction FEE based on database hits. Emitted (VM-synthesized)
        // actions pay no separate per-tx fee. See util.feeForAction. Without this,
        // getTransactionFee > 0 + detectFeePaymentMode('xchain') rejects every contract-emitted
        // SWEEP as 'insufficient funds (FEE)'.
        fees['AMOUNT'] = this.util.feeForAction(this.util.getTransactionFee(db_hits, fees['TICK']), data);

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

        // Controller-bound tokens: gate the OUTBOUND move of each swept balance. For every swept tick
        // whose `transfer` class is bound to a controller, run that contract's `guard` once on the
        // aggregate move (from=SOURCE, to=DESTINATION, amount=balance). ANY deny fails the WHOLE SWEEP
        // (fail-closed, per the chosen bounded-aggregate model). SOURCE pays the cumulative guard gas
        // in GAS, reserved out of `balances` as we go so the swept GAS amount below already excludes it
        // (SOURCE is never over-debited). Guard executions are iterated in byte (binary) order of the
        // RESOLVED tick STRING - the consensus-stable key (matching actions.js's pending byte-sort and
        // the getBlockHashes utf8_bin tiebreak), NOT ascending tick_id. tick_id is a local
        // index_tickers AUTO_INCREMENT surrogate assigned on first reference and surviving reorgs, so
        // two nodes whose id assignment diverged post-reorg would run the guards in a different order
        // and, via contract_executions last-write-wins + emission basePosition, commit a different
        // contract_hash for the same block (BLOCK_HASH_VERSION rationale, db.js). Ownership transfers
        // (the ISSUE loop below) are a separate capability and are NOT gated by this class. Only runs
        // when BALANCES are swept, and is a strict no-op before the CONTROLLER_GUARD flag-day.
        if(!error && data['BALANCES']==1){
            // Resolve each swept tick_id to its canonical ticker, then order guard runs by that
            // string. The amount is read fresh INSIDE the loop (not captured here): a prior guard's
            // gas fee can debit a swept tick's balance mid-loop, so the order must not fix the amount.
            let sweptTicks = [];
            for(let sweepTickId of Object.keys(balances)){
                let sweepTick = await resolveTicker(Number(sweepTickId));
                if(this.util.isNull(sweepTick)) continue;
                sweptTicks.push({ tick_id: Number(sweepTickId), tick: sweepTick });
            }
            sweptTicks.sort((a, b) => Buffer.compare(Buffer.from(a.tick, 'utf8'), Buffer.from(b.tick, 'utf8')));
            for(let { tick_id, tick } of sweptTicks){
                if(error) break;
                let amount = balances[tick_id];
                if(this.util.isNull(amount) || !this.util.bcgt(String(amount), '0')) continue;
                let result = await this.util.maybeRunControllerGuard(this.actions, this.indexerDb, {
                    actionType:  'SWEEP',
                    tick:        tick,
                    from:        data['SOURCE'],
                    to:          data['DESTINATION'],
                    amount:      String(amount),
                    data:        data,
                    gasInfo:     gasInfo,
                    gasBalances: balances,
                    seq:         Number(tick_id) || 0
                });
                if(result.error){
                    error = 'invalid: ' + result.error;
                } else if(this.util.bcgt(result.guardFee, 0)){
                    guardFee = this.util.bcadd(guardFee, result.guardFee, 8);
                    if(gasInfo)
                        balances = this.util.debitBalances(balances, gasInfo['TICK_ID'], result.guardFee);
                }
            }
        }

        // Controller-bound tokens: gate the deed-over of each swept OWNERSHIP (the settlement
        // OWNERSHIPS loop below turns each into a transfer ISSUE). For every tick whose ownership
        // SOURCE currently holds, if that tick's `ownership` class is bound to a controller, run its
        // `guard` once (actionType SWEEP_OWNERSHIP → class `ownership`; from=SOURCE, to=DESTINATION)
        // before the deed settles - so an issuer can make ownership non-sweepable to an unapproved
        // DESTINATION independent of whether balances are transferable. ANY deny fails the WHOLE SWEEP
        // (fail-closed, mirroring the BALANCES guard: the deed must be gated BEFORE status is fixed to
        // 'valid', since the settlement loop only runs on a valid sweep and cannot cleanly revert one
        // ownership after the ledger has been written). SOURCE pays the cumulative guard gas in GAS,
        // folded into the same `guardFee` the settlement debit bills and reserved out of `balances` as
        // we go so the swept GAS credited to DESTINATION already excludes it. Guards run in byte order
        // of the tick STRING - the consensus-stable key (see the BALANCES loop for the tick_id-
        // divergence rationale), never DB/array order. Escrowed-ownership ticks are delivered by the
        // ORDERS/SWAPS close path (a `trade` concern) and are already excluded from `ownerships`. Only
        // runs when OWNERSHIPS are swept; a strict no-op before the CONTROLLER_GUARD flag-day.
        if(!error && data['OWNERSHIPS']==1){
            let ownershipTicks = [...ownerships]
                .filter(t => !this.util.isNull(t))
                .sort((a, b) => Buffer.compare(Buffer.from(String(a), 'utf8'), Buffer.from(String(b), 'utf8')));
            let ownershipSeq = 0;
            for(let tick of ownershipTicks){
                if(error) break;
                let result = await this.util.maybeRunControllerGuard(this.actions, this.indexerDb, {
                    actionType:  'SWEEP_OWNERSHIP',
                    tick:        tick,
                    from:        data['SOURCE'],
                    to:          data['DESTINATION'],
                    amount:      '',
                    data:        data,
                    gasInfo:     gasInfo,
                    gasBalances: balances,
                    seq:         ownershipSeq++
                });
                if(result.error){
                    error = 'invalid: ' + result.error;
                } else if(this.util.bcgt(result.guardFee, 0)){
                    guardFee = this.util.bcadd(guardFee, result.guardFee, 8);
                    if(gasInfo)
                        balances = this.util.debitBalances(balances, gasInfo['TICK_ID'], result.guardFee);
                }
            }
        }

        let status = (error) ? error : 'valid';
        data['STATUS'] = sweep['STATUS'] = status;

        console.log("\t SWEEP : " + sweep['DESTINATION'] + ' : '+ sweep['STATUS']);

        await this.indexerDb.createSweep(sweep);

        if(status=='valid'){
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
                        // Balance order: standard escrow → DESTINATION.
                        // BigNumber-space negation, not JS unary minus (float truncation).
                        escrows.push([info['GIVE_TICK'], this.util.bcsub(0, info['GIVE_REMAINING'], 64), info['SOURCE']]);
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
                    // Balance swap: standard escrow → DESTINATION.
                    // BigNumber-space negation, not JS unary minus (float truncation).
                    escrows.push([info['GIVE_TICK'], this.util.bcsub(0, info['GIVE_AMOUNT'], 64), info['SOURCE']]);
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

            if(data['BALANCES']==1){
                for(let tick_id in balances){
                    let amount = balances[tick_id];
                    let tick   = await resolveTicker(tick_id);

                    debits.push([tick,  amount, data['SOURCE']]);
                    credits.push([tick, amount, data['DESTINATION']]);

                    this.util.addAddressTicker(data['SOURCE'], tick);
                    this.util.addAddressTicker(data['DESTINATION'], tick);
                }
            }

            await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits, escrows);

            let tickers   = this.util.getTickersList(),
                addresses = Object.keys(this.util.getAddressesList());

            await this.indexerDb.updateBalances(addresses);
            await this.indexerDb.updateTokens(tickers);

            await this.mapper.createMappings(data);

            // Transfer token ownerships. Each swept ownership's controller (if any) was already run
            // in the validation-phase `ownership`-class guard loop above; a deny there failed the
            // whole SWEEP before status reached 'valid', so every deed reaching here is authorized.
            if(data['OWNERSHIPS']==1){
                for(let tick of ownerships){

                    // Ownership already delivered to DESTINATION by the
                    // ORDERS/SWAPS escrow-close path above: never issue a
                    // second transfer for it.
                    if(ownershipsTransferred.has(tick))
                        continue;

                    // Reset the address/tickers/transactions list on each parse: each ownership
                    // iteration below builds its own ISSUE and must not carry the prior one's lists.
                    this.util.resetLists();

                    let issue = sweep;
                    issue['ACTION']   = 'ISSUE';
                    issue['TICK']     = tick;
                    issue['TRANSFER'] = sweep['DESTINATION'];

                    issue['ACTION_INDEX'] = await this.indexerDb.createActionIndex(issue, true);

                    await this.indexerDb.createIssue(issue);

                    await this.indexerDb.updateTokens(tick);

                    this.util.addAddressTicker(issue['SOURCE'], tick);
                    this.util.addAddressTicker(issue['DESTINATION'], tick);

                    await this.mapper.createMappings(issue);
                }
            }

        }
    }
}

module.exports = Sweep;