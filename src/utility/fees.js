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
 * XChain Indexer - Utility: protocol fees
 *
 * The protocol fee schedule: default expirations, the fee object, per-action and unified
 * fees, the guard gas reservation, the fee payment mode and the duration/expiration fees.
 *
 ********************************************************************/

'use strict';

const config = require('../config.js');

// Installed onto Utility.prototype by ../utility.js, non-enumerable; each method runs with
// `this` bound to the Utility instance, exactly as the class method it was.
module.exports = {

    // Handle getting the default EXPIRATION
    getDefaultExpiration(block_time){
        // Get current time in seconds
        let now = block_time;
        // Get number of seconds in EXPIRATION_FEE_DEFAULT_DAYS
        let sec = this.bcmul(this.config['EXPIRATION_FEE_DEFAULT_DAYS'], 86400, 0);
        return this.bcadd(now, sec, 0);
    },

    // Create the basic fees object used to calculate platform transaction fees
    async createFeesObject(db, data, preferences){
        let tick    = this.config['GAS'];
        let tick_id = await db.getTickerId(tick);
        let fees = {
            ACTION_INDEX : data['ACTION_INDEX'],
            SOURCE       : data['SOURCE'],
            TICK         : tick,
            TICK_ID      : tick_id,
            AMOUNT       : 0,
            METHOD       : (preferences['FEE_PREFERENCE']==1) ? 1 : 2, // 1=Destroy, 2=Donate
            // Unified gas fields (populated when UNIFIED_FEES is active)
            GAS_COST     : 0,
            GAS_PRICE    : this.config['GAS_PRICE'] || '0.00001',
            PAYMENT_MODE : 2, // 2=xchain_balance (Track A default)
            FEE_VERSION  : 1  // 1=legacy, updated to 2 when unified fees active
        };
        return fees;
    },

    // Calculate Transaction fee based on number of database hits (legacy)
    getTransactionFee(db_hits, tick){
        let cost = 1000,                              // Cost in sats per DB hit
            sats = this.bcmul(db_hits, cost , 0),     // FEE in sats (integer)
            fee  = this.bcmul(sats, '0.00000001', 8); // FEE in decimal (divisible)
        return fee;
    },

    // Per-tx protocol fee for a possibly-emitted action. VM-emitted actions (synthesized
    // inside an EXECUTE, flagged IS_EMISSION) pay no separate per-tx fee: the VM already
    // charges VM_EMISSION gas to the EXECUTE caller, and the fee model validates against the
    // EXECUTE tx's fee-destination outputs, which don't belong to a synthesized action (no
    // native fee output, and the contract SOURCE need not hold XCHAIN). Returns the computed
    // fee for normal on-wire actions, 0 for emissions. Mirrors execute.js's
    // `skipFee = Boolean(IS_EMISSION)`. NOTE: this is the per-tx processing fee only; it does
    // NOT cover deliberate economic fees (e.g. the ISSUE issuance fee), which are left intact.
    feeForAction(amount, data){
        return (data && data['IS_EMISSION']) ? '0' : amount;
    },

    // Resolve the consensus-critical controller-guard gas ceiling from the gas schedule.
    // VM_GUARD_GAS_CEILING bounds the guard fee reserved/billed against SOURCE and is
    // committed into the ledger/contract hashes, so a node that silently fell back to a
    // hard-coded default (because its GAS_SCHEDULE omits or mistypes the key) would bill a
    // different amount than a correctly configured node and fork on the first guarded action
    // after the CONTROLLER_GUARD flag-day. Treat it as a canonical key: validate (positive
    // integer, no trailing garbage) and throw loudly rather than mint a phantom default.
    // Read once via this single resolver at every guard-fee site so the two cannot drift.
    resolveGuardGasCeiling(config){
        let schedule = (config && config['GAS_SCHEDULE']) || {};
        let raw = schedule['VM_GUARD_GAS_CEILING'];
        let val = parseInt(raw, 10);
        if(raw === undefined || raw === null || !Number.isInteger(val) || val <= 0 || String(raw).trim() !== String(val)){
            throw new Error('GAS_SCHEDULE.VM_GUARD_GAS_CEILING missing or invalid (expected a positive integer, got ' + JSON.stringify(raw) + ')');
        }
        return val;
    },

    // Is the controller-guard gas ceiling reserved against SOURCE's GAS balance on THIS chain?
    //
    // Reserving an XCHAIN balance is a BTC-only rule today, but nothing states it: off BTC the
    // reservation is skipped only because getTokenInfo('XCHAIN') returns null there, so the
    // caller passes gasInfo = null and the comparison below never runs. The XCHAIN bridge
    // creates a real XCHAIN row on LTC and DOGE the first time a transfer settles there, and
    // from that block gasInfo is non-null: a controller-guarded ORDER, SEND or DISPENSER from
    // a source holding no XCHAIN would flip from valid to 'invalid: insufficient funds (guard
    // gas)' at the block the row appears, with no flag day naming the change. Key the rule on
    // the coin instead of on the row's existence, so the row can be created without moving one
    // verdict: the reservation is BTC-only until the XCHAIN_FEE_MODE_ALL_CHAINS flag
    // day widens XCHAIN-balance fees to every chain, and this predicate is the one line that
    // widens with it. Off BTC this is byte-identical to the behaviour before the bridge, so no
    // replayed verdict moves on any chain and no pre-activation hash moves.
    // COIN resolution mirrors detectFeePaymentMode: the process config first, the action's own
    // stamped COIN as the fallback.
    isGuardGasReserved(data){
        let coin = this.config['COIN'] || (data && data['COIN']);
        return coin === 'BTC';
    },

    // Calculate Transaction fee using unified gas schedule (per-recipient)
    getUnifiedTransactionFee(recipients, gasType){
        let schedule  = this.config['GAS_SCHEDULE'];
        let gasPerRecipient = schedule[gasType] || 100;
        let gasCost   = this.bcmul(recipients, gasPerRecipient, 0);
        let fee       = this.bcmul(gasCost, this.config['GAS_PRICE'], 8);
        return { gasCost: gasCost, fee: fee };
    },

    // Resolve one consensus-critical GAS_SCHEDULE cost, strictly.
    //
    // getUnifiedTransactionFee above silently substitutes 100 for a key its schedule does
    // not carry. That is survivable for a key every shipped bundle has held since the
    // unified schedule existed, but it is the wrong shape for a key added later: a node
    // whose GAS_SCHEDULE omits or mistypes it would price the action at a phantom default,
    // commit a different fee DEBIT than a correctly configured node, and fork on the first
    // fee-bearing action of that kind. Same rule and same reasoning as
    // resolveGuardGasCeiling: validate (integer, non-negative, no trailing garbage) and
    // throw loudly rather than mint a default. CONSENSUS_CONFIG_PIN already fails a node
    // closed at boot when its bundle's GAS_SCHEDULE differs from the pinned one, so this is
    // the second line, reached only by a bundle that somehow got past it.
    resolveGasScheduleCost(key){
        let schedule = this.config['GAS_SCHEDULE'] || {};
        let raw = schedule[key];
        let val = parseInt(raw, 10);
        if(raw === undefined || raw === null || !Number.isInteger(val) || val < 0 || String(raw).trim() !== String(val)){
            throw new Error('GAS_SCHEDULE.' + key + ' missing or invalid (expected a non-negative integer, got ' + JSON.stringify(raw) + ')');
        }
        return val;
    },

    // Calculate a transaction fee on the unified gas schedule as a flat BASE cost plus a
    // per-item cost: fee = (base + items * perItem) * GAS_PRICE.
    //
    // The base term is the point. A purely per-item price (what getUnifiedTransactionFee
    // computes, and what the legacy per-DB-hit model computed) makes the smallest instance
    // of an action arbitrarily cheap, and on a chain where the protocol fee MUST be paid as
    // a native-coin output (LTC/DOGE: see detectFeePaymentMode, which rejects rather than
    // falling back to an XCHAIN balance debit) an arbitrarily cheap fee is an output below
    // the chain's dust threshold, which cannot be created at all. The action is then not
    // expensive, it is unsubmittable. A base cost puts a floor under the output. See the
    // SWEEP_BASE / CALLBACK_BASE comment in the coin bundles for how the values are sized.
    //
    // Returns { gasCost, fee }, the same shape getUnifiedTransactionFee returns, so both
    // feed fees['GAS_COST'] / fees['AMOUNT'] identically.
    getUnifiedBaseItemFee(items, baseKey, perItemKey){
        let base    = this.resolveGasScheduleCost(baseKey);
        let perItem = this.resolveGasScheduleCost(perItemKey);
        let gasCost = this.bcadd(base, this.bcmul(items, perItem, 0), 0);
        let fee     = this.bcmul(gasCost, this.config['GAS_PRICE'], 8);
        return { gasCost: gasCost, fee: fee };
    },

    // Flat premium charged when an ORDER/SWAP/DISPENSER create escrows ownership of a tick.
    // Added on top of the expiration fee in the UNIFIED_FEES path; legacy fees do not charge it.
    getOwnershipEscrowFee(){
        let schedule = this.config['GAS_SCHEDULE'];
        let gasCost  = schedule.OWNERSHIP_ESCROW || 0;
        let fee      = this.bcmul(gasCost, this.config['GAS_PRICE'], 8);
        return { gasCost: gasCost, fee: fee };
    },

    // Detect fee payment mode from the transaction
    // Returns: 'native' if fee output present, 'xchain' if absent on BTC, 'rejected' if absent on LTC/DOGE
    detectFeePaymentMode(data, decoderDb, txOutputs){
        // Emitted/synthesized actions (IS_EMISSION: VM emissions, XEXEC, ATTEST
        // responses) have no transaction of their own, so they can never carry a
        // native fee output. Their economic fee is paid from the emitting
        // contract's XCHAIN balance on EVERY chain (including LTC/DOGE, where a
        // top-level action with no fee output is rejected. Without this, a
        // contract-emitted ISSUE (or any emitted economic-fee action) is
        // unconditionally rejected on LTC/DOGE ('native coin output required'),
        // which BTC masks via its own xchain fallback below.
        if(data && data['IS_EMISSION']) return 'xchain';

        let feeDestination = this.config['ADDRESS'] ? this.config['ADDRESS']['FEE_DESTINATION'] : null;
        if(!feeDestination || feeDestination === 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX') {
            // No fee destination configured; fall back to xchain balance deduction
            return 'xchain';
        }

        // Check if any transaction output pays to the fee destination address
        let feeOutput = null;
        if(txOutputs && Array.isArray(txOutputs)){
            for(let output of txOutputs){
                if(output.address === feeDestination || output.scriptPubKey_address === feeDestination){
                    feeOutput = output;
                    break;
                }
            }
        }

        if(feeOutput){
            return 'native'; // Fee output found: native coin payment
        }

        // No fee output; implicit detection
        let coin = this.config['COIN'] || data['COIN'];
        if(coin === 'BTC'){
            return 'xchain'; // BTC allows XCHAIN balance deduction as fallback
        }

        // LTC/DOGE: native coin is the only option; missing fee output = rejected
        return 'rejected';
    },

    // Calculate expiration fee (legacy per-chain rate)
    getExpirationFee(data, info){
        let fee    = 0,
            format = data['FORMAT'];
        // Create Order / Swap / Dispenser
        if(format==0){
            let expire_seconds = this.bcsub(data['EXPIRATION'], data['BLOCK_TIME'], 0);
            let expire_days    = this.bcdiv(expire_seconds, 86400, 0);
            fee                = this.bcgt(expire_days, this.config['EXPIRATION_FEE_FREE_DAYS']) ? (this.bcmul(expire_days, this.config['EXPIRATION_FEE_PER_DAY'],8)) : 0;
        }
        // Edit Order / Swap / Dispenser
        if(format==2 && this.bcgt(data['EXPIRATION'], info['EXPIRATION'])){
            let orig_expire_seconds = this.bcsub(info['EXPIRATION'], info['BLOCK_TIME'], 0);
            let orig_expire_days    = this.bcdiv(orig_expire_seconds, 86400, 0);
            let edit_expire_seconds = this.bcsub(data['EXPIRATION'], info['BLOCK_TIME'], 0);
            let edit_expire_days    = this.bcdiv(edit_expire_seconds, 86400, 0);
            // Only calculate FEE if increasing EXPIRATION date and greater than EXPIRATION_FEE_FREE_DAYS
            if(this.bcgt(data['EXPIRATION'], info['EXPIRATION']) && this.bcgt(edit_expire_days, this.config['EXPIRATION_FEE_FREE_DAYS'])){
                let expire_days = this.bcsub(edit_expire_days, orig_expire_days, 0);
                fee             = this.bcmul(expire_days, this.config['EXPIRATION_FEE_PER_DAY'],8);
            }
        }
        return fee;
    },

    // Calculate expiration fee (unified gas schedule)
    // Duration-metered creation fee shared by every action family that occupies a
    // per-block scan index for its lifetime: ORDER / SWAP / DISPENSER (EXPIRATION_PER_DAY,
    // via getUnifiedExpirationFee below) and BET feeds (BET_FEED_PER_DAY, spec decision F:
    // standardized on this mechanism rather than a betting-specific one). Extracted as a
    // pure transplant of the historical format-0 arithmetic so byte-identity across the
    // families is structural; a unit test pins the two paths equal across the free-window
    // boundary. NOTE the day count uses bcdiv at 0 decimals, which formats through mathjs
    // fixed-precision and therefore ROUNDS TO NEAREST (90.4 days -> 90, 90.5 days -> 91).
    // That is the shipped consensus behavior for ORDER fees; do NOT "fix" it to a floor
    // here or every fractional-day boundary forks from the historical fee.
    getUnifiedDurationFee(untilTimestamp, blockTime, gasKey){
        let schedule  = this.config['GAS_SCHEDULE'];
        let freeDays  = this.config['UNIFIED_EXPIRATION_FEE_FREE_DAYS'] || 90;
        let gasCost   = 0;
        let fee       = 0;
        let expire_seconds = this.bcsub(untilTimestamp, blockTime, 0);
        let expire_days    = this.bcdiv(expire_seconds, 86400, 0);
        let chargeableDays = this.bcsub(expire_days, freeDays, 0);
        if(this.bcgt(chargeableDays, 0)){
            gasCost = this.bcmul(chargeableDays, schedule[gasKey], 0);
            fee     = this.bcmul(gasCost, this.config['GAS_PRICE'], 8);
        }
        return { gasCost: gasCost, fee: fee };
    },

    getUnifiedExpirationFee(data, info){
        let schedule  = this.config['GAS_SCHEDULE'];
        let freeDays  = this.config['UNIFIED_EXPIRATION_FEE_FREE_DAYS'] || 90;
        let gasCost   = 0;
        let fee       = 0;
        let format    = data['FORMAT'];
        // Create Order / Swap / Dispenser (shared duration arithmetic; see above)
        if(format==0){
            let duration = this.getUnifiedDurationFee(data['EXPIRATION'], data['BLOCK_TIME'], 'EXPIRATION_PER_DAY');
            gasCost = duration.gasCost;
            fee     = duration.fee;
        }
        // Edit Order / Swap / Dispenser
        if(format==2 && info && this.bcgt(data['EXPIRATION'], info['EXPIRATION'])){
            let orig_expire_seconds = this.bcsub(info['EXPIRATION'], info['BLOCK_TIME'], 0);
            let orig_expire_days    = this.bcdiv(orig_expire_seconds, 86400, 0);
            let edit_expire_seconds = this.bcsub(data['EXPIRATION'], info['BLOCK_TIME'], 0);
            let edit_expire_days    = this.bcdiv(edit_expire_seconds, 86400, 0);
            if(this.bcgt(edit_expire_days, freeDays)){
                let additionalDays = this.bcsub(edit_expire_days, orig_expire_days, 0);
                gasCost = this.bcmul(additionalDays, schedule.EXPIRATION_PER_DAY, 0);
                fee     = this.bcmul(gasCost, this.config['GAS_PRICE'], 8);
            }
        }
        return { gasCost: gasCost, fee: fee };
    }
};
