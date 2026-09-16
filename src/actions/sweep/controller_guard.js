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
 * SWEEP controller guards: before a SWEEP settles, run the `guard` of every
 * controller bound to a swept balance's `transfer` class or a swept ownership's
 * `ownership` class. Any deny fails the whole SWEEP; SOURCE pays the cumulative
 * guard gas in GAS, reserved out of the swept balances as it accrues.
 *
 ********************************************************************/

// Installed onto Sweep.prototype by sweep.js; each method runs with `this` bound to
// the handler, exactly as the parse() code it came from. `state` is the object
// loadSweepState() built: the guard gas accrues in state.guardFee and each reserve
// replaces state.balances.
module.exports = {

    // Controller-bound tokens: gate the OUTBOUND move of each swept balance. For every swept tick
    // whose `transfer` class is bound to a controller, run that contract's `guard` once on the
    // aggregate move (from=SOURCE, to=DESTINATION, amount=balance). ANY deny fails the WHOLE SWEEP
    // (fail-closed, per the chosen bounded-aggregate model). SOURCE pays the cumulative guard gas
    // in GAS, reserved out of `balances` as we go so the swept GAS amount below already excludes it
    // (SOURCE is never over-debited). Guard executions are iterated in byte (binary) order of the
    // RESOLVED tick STRING - the consensus-stable key (matching actions/index.js's pending byte-sort and
    // the getBlockHashes utf8_bin tiebreak), NOT ascending tick_id. tick_id is a local
    // index_tickers AUTO_INCREMENT surrogate assigned on first reference and surviving reorgs, so
    // two nodes whose id assignment diverged post-reorg would run the guards in a different order
    // and, via contract_executions last-write-wins + emission basePosition, commit a different
    // contract_hash for the same block (BLOCK_HASH_VERSION rationale, db.js). Ownership transfers
    // (the ISSUE loop below) are a separate capability and are NOT gated by this class. Only runs
    // when BALANCES are swept, and is a strict no-op before the CONTROLLER_GUARD flag-day.
    // Returns the error.
    async guardSweptBalances(data, state, error){
        if(!error && data['BALANCES']==1){
            // Resolve each swept tick_id to its canonical ticker, then order guard runs by that
            // string. The amount is read fresh INSIDE the loop (not captured here): a prior guard's
            // gas fee can debit a swept tick's balance mid-loop, so the order must not fix the amount.
            let sweptTicks = [];
            for(let sweepTickId of Object.keys(state.balances)){
                let sweepTick = await state.resolveTicker(Number(sweepTickId));
                if(this.util.isNull(sweepTick)) continue;
                sweptTicks.push({ tick_id: Number(sweepTickId), tick: sweepTick });
            }
            sweptTicks.sort((a, b) => Buffer.compare(Buffer.from(a.tick, 'utf8'), Buffer.from(b.tick, 'utf8')));
            for(let { tick_id, tick } of sweptTicks){
                if(error) break;
                let amount = state.balances[tick_id];
                if(this.util.isNull(amount) || !this.util.bcgt(String(amount), '0')) continue;
                let result = await this.util.maybeRunControllerGuard(this.actions, this.indexerDb, {
                    actionType:  'SWEEP',
                    tick:        tick,
                    from:        data['SOURCE'],
                    to:          data['DESTINATION'],
                    amount:      String(amount),
                    data:        data,
                    gasInfo:     state.gasInfo,
                    gasBalances: state.balances,
                    seq:         Number(tick_id) || 0
                });
                error = this.chargeSweepGuard(result, state, error);
            }
        }
        return error;
    },

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
    // Returns the error.
    async guardSweptOwnerships(data, state, error){
        if(!error && data['OWNERSHIPS']==1){
            let ownershipTicks = [...state.ownerships]
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
                    gasInfo:     state.gasInfo,
                    gasBalances: state.balances,
                    seq:         ownershipSeq++
                });
                error = this.chargeSweepGuard(result, state, error);
            }
        }
        return error;
    },

    // Fold one guard verdict into the SWEEP, the same way for both guard loops: a deny
    // becomes the error; otherwise any guard gas joins state.guardFee and is reserved out
    // of the swept GAS balance. Returns the error.
    chargeSweepGuard(result, state, error){
        if(result.error){
            error = 'invalid: ' + result.error;
        } else if(this.util.bcgt(result.guardFee, 0)){
            state.guardFee = this.util.bcadd(state.guardFee, result.guardFee, 8);
            if(state.gasInfo)
                state.balances = this.util.debitBalances(state.balances, state.gasInfo['TICK_ID'], result.guardFee);
        }
        return error;
    }
};
