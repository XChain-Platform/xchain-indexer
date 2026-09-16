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
 * XChain Indexer - Utility: PRICE v1 oracle usage fee
 *
 * The oracle usage fee a Mode B dispenser open or refill owes its oracle: the fee math,
 * the dust floor, the effective-price precondition, the quote and the consensus check.
 *
 ********************************************************************/

'use strict';

// The hub-vendored coin registry. config.js, which ../utility.js loads first, already loads
// it (through coins/to_indexer_config.js), so binding it here moves no module earlier in
// load order. Held as the module object, not destructured, so getCoinConfig is looked up
// per call.
const coinRegistry = require('../coins');
const { findFeeOutput } = require('./fee_output.js');

// Batch-cumulative oracle-fee accounting (BATCH_ISSUANCE_LIMITS), the same
// shape validateNativeCoinFee uses for the native fee pool.
//
// TX_OUTPUTS is TRANSACTION-level state that the batch loop preserves across every
// sub-command, and nothing decrements it. So before this, each Mode B DISPENSER
// open/refill in one batch judged the SAME untouched oracle-fee output from zero:
// N opens referencing one oracle paid ONE oracle fee.
//
// The tally is keyed BY ORACLE ADDRESS rather than being a scalar: one batch may
// reference several oracles, each paid by its own output, and one exhausted
// output must never invalidate a sub-command paying a different oracle.
//
// The ledger's ABSENCE is both the flag gate and the not-a-batch case: with no
// ledger every line below collapses to the pre-existing behavior, which is what a
// non-BATCH transaction and a pre-flag-day BATCH must still see, byte for byte.
//
// data['FEE_PROBE'] marks the read-only public quote path. actions/dispenser.js
// routes a probe to quoteOracleFee (which reads no output at all), so a probe does
// not reach here today; this guard keeps that true for any later caller, because
// letting the public quote API mutate consensus state is the sharpest edge here.
//
// Returns this transaction's per-oracle tally, or null when no tally is in play.
function oracleFeeTally(data){
    return (!data['FEE_PROBE'] && data['BATCH_VALUE_LEDGER'] &&
            typeof data['BATCH_VALUE_LEDGER'] === 'object' &&
            data['BATCH_VALUE_LEDGER']['oracleFeeConsumed'] &&
            typeof data['BATCH_VALUE_LEDGER']['oracleFeeConsumed'] === 'object')
               ? data['BATCH_VALUE_LEDGER']['oracleFeeConsumed'] : null;
}

// Judge the output paying the oracle against the expected fee and, inside a BATCH, draw this
// command's share of that oracle's pool. The tail of validateOracleFee, which calls it once the
// quote says a fee is owed and the output paying the oracle has been found.
//
// Returns the validateOracleFee verdict: { valid, error?, expectedFee, paidAmount? }.
function drawOracleFeeOutput(util, data, oracleAddress, expectedFee, feeOutput){
    let paidAmount   = util.bcnum(feeOutput.value || feeOutput.amount || 0);
    let toleranceMin = util.bcnum(util.config['FEE_TOLERANCE_MIN'] || '0.95');
    let minAcceptable = util.bcmul(expectedFee, toleranceMin, 8);

    let tally     = oracleFeeTally(data);
    let consumed  = tally ? (tally[oracleAddress] || '0') : '0';
    let available = tally ? util.bcsub(paidAmount, consumed, 8) : paidAmount;

    // `available` is `paidAmount` verbatim when no tally is in play, so both strings
    // below are unchanged off the batch path; mid-batch they report what is actually
    // left of THIS oracle's output rather than the whole of it, which no longer
    // belongs to one command alone.
    if(util.bclt(available, minAcceptable))
        return { valid: false,
                 error: 'invalid: ORACLE_ADDRESS (insufficient oracle fee, paid ' +
                        util.bcformat(available, 8) + ', expected ' + util.bcformat(expectedFee, 8) + ')',
                 expectedFee: util.bcformat(expectedFee, 8),
                 paidAmount:  util.bcformat(available, 8) };

    // Attribute at most ONE command's expected fee to this command and drain this
    // oracle's pool by that much. Draining at minAcceptable would compound the
    // per-command 0.95x tolerance across the batch: a batch paying N commands' worth
    // would validate ~1.05N commands. Draining at expectedFee makes N commands' worth
    // cover exactly N. Tally values stay decimal STRINGS at 8dp, accumulated with
    // bcadd, never JS numbers.
    let attributed = paidAmount;
    if(tally){
        attributed = util.bclt(available, expectedFee) ? available : expectedFee;
        tally[oracleAddress] = util.bcformat(util.bcadd(consumed, attributed, 8), 8);
    }

    return { valid: true,
             expectedFee: util.bcformat(expectedFee, 8),
             paidAmount:  util.bcformat(attributed, 8) };
}

// Installed onto Utility.prototype by ../utility.js, non-enumerable; each method runs with
// `this` bound to the Utility instance, exactly as the class method it was.
module.exports = {

    // Pure PRICE v1 oracle-usage fee math. Counterparty parity: the address
    // OPENING a Mode B dispenser pays the oracle operator up front, proportional to the
    // whole escrow's projected proceeds, rather than buyers paying per dispense.
    //
    // Counterparty's calculate_oracle_fee (counterparty-core dispenser.py) is
    //     oracle_mainchainrate_btc = fiat_price_per_dispense / oracle_price
    //     remaining                = floor(escrow_quantity / give_quantity)
    //     fee                      = remaining * oracle_mainchainrate_btc * fee_multiplier
    // where ITS oracle broadcasts the COIN/FIAT rate. XChain's PRICE v1 oracle prices the
    // TOKEN in fiat instead (the COIN/FIAT rate comes from the validator federation), so
    // the per-dispense fiat cost is `oraclePrice * giveAmount` and the dispense count is
    // `giveEscrow / giveAmount`. giveAmount cancels, leaving the simpler identity below.
    // Kept as the same product Counterparty computes, just with the cancellation applied:
    //
    // That per-dispense premise is what SETTLEMENT does only at/above
    // DISPENSER_ORACLE_PER_TOKEN_PRICE. Below it, dispense.js spent the published price
    // as the price of one whole FILL, so the fee an oracle was paid and the proceeds the
    // dispenser could actually take in differed by a factor of giveAmount. This
    // function is unchanged either side of that flag day: per-token is the canonical
    // reading and this is the surface that already had it right.
    //
    //     projected_fiat_total = oraclePrice * giveEscrow
    //     projected_coin_total = projected_fiat_total / coinFiatPrice
    //     fee                  = projected_coin_total * feeFraction
    //
    // All bignumber, 18-decimal intermediates and an 8-decimal (satoshi) result, matching
    // computeNativeFeeBand's precision discipline so a client's output sizing and the
    // validator's acceptance test cannot disagree by a rounding step.
    //
    // Returns a bignumber. Callers treat a result below the chain's dust threshold as
    // "no output required" (Counterparty skips the output below DEFAULT_REGULAR_DUST_SIZE).
    computeOracleFee(oraclePrice, giveEscrow, coinFiatPrice, feeFraction){
        let projectedFiat = this.bcmul(oraclePrice, giveEscrow, 18);
        let projectedCoin = this.bcdiv(projectedFiat, coinFiatPrice, 18);
        return this.bcmul(projectedCoin, feeFraction, 8);
    },

    // This chain's dust threshold as a decimal coin amount (bignumber).
    //
    // dustThreshold lives in SATOSHIS on the coin bundle's `net` block
    // (src/coins/<COIN>.js: BTC 546, DOGE 100000), which is NOT merged onto the
    // indexer's runtime config - `config.net` is undefined there, so it has to be read
    // from the bundle directly. TX_OUTPUTS values are decimal coin, hence the /1e8.
    //
    // Consensus-relevant (it decides whether an oracle-fee output is required at all),
    // so it is read from the pinned coin bundle rather than from anything an operator
    // can set. Cached because it is constant for the life of the process.
    getDustThresholdCoin(){
        if(this._dustThresholdCoin === undefined){
            let sats = 0;
            try {
                let bundle = coinRegistry.getCoinConfig(this.config['COIN'], this.config['NETWORK']);
                sats = (bundle && bundle.net && bundle.net.dustThreshold) || 0;
            } catch(e){
                sats = 0;   // unknown coin/network: no dust floor rather than a hard failure
            }
            this._dustThresholdCoin = this.bcdiv(sats, '100000000', 8);
        }
        return this._dustThresholdCoin;
    },

    // VALIDITY precondition for any Mode B (oracle-priced) dispenser: the oracle it names
    // must already have an EFFECTIVE price for the pair. Operator ruling 2026-07-25: a
    // dispenser must reference an oracle that has prices set. Oracle operators are a
    // separate, ongoing service from dispenser operators, so the normal path is to point
    // at an established feed whose price is already effective; only someone standing up
    // their own oracle for their own dispenser meets the 24h activation delay, and
    // waiting is correct for them. Accepting the create with no effective price instead
    // would be a free-oracle-usage loophole: publish, create immediately, never pay.
    //
    // Deliberately its OWN method rather than a step buried in quoteOracleFee. This rule is
    // about whether the dispenser is valid at all, not about how large a fee it owes, and
    // the two obligations have different scopes: the fee is sized by GIVE_ESCROW and is
    // therefore nil for an escrow-less create, while the price precondition binds every
    // Mode B action regardless of escrow. Living only inside the fee path made it
    // unreachable for exactly the creates that escrow nothing (ownership dispensers, whose
    // GIVE_ESCROW must be empty). quoteOracleFee still calls it as its first step, so the
    // fee path keeps a single source of truth and its behavior is unchanged.
    //
    //   dispenser: { ORACLE_ADDRESS, GIVE_COIN, GIVE_TICK, FIAT_CODE }
    //
    // Returns { valid, error? }.
    async requireEffectiveOraclePrice(blockTime, dispenser, db){
        let oracleRow = await db.getOraclePrice(
            dispenser['ORACLE_ADDRESS'], dispenser['GIVE_COIN'], dispenser['GIVE_TICK'],
            dispenser['FIAT_CODE'], Number(blockTime));
        if(!oracleRow)
            return { valid: false, error: 'invalid: ORACLE_ADDRESS (no effective oracle price)', oracleRow: null };
        return { valid: true, oracleRow: oracleRow };
    },

    // Consensus check for the PRICE v1 oracle usage fee on a Mode B dispenser open or
    // refill. Deliberately the same shape as validateNativeCoinFee below: derive
    // an expected native amount from oracle prices, find the required output in
    // data['TX_OUTPUTS'], reject when it is missing or short of a tolerance band. Sharing
    // the shape (and the FEE_TOLERANCE_* band) is what keeps a payer's output sizing and a
    // validator's acceptance test from disagreeing.
    //
    //   dispenser: { ORACLE_ADDRESS, GIVE_COIN, GIVE_TICK, FIAT_CODE, GIVE_ESCROW, GET_COIN }
    //              GIVE_ESCROW is the amount being escrowed by THIS action, so a v2 refill
    //              passes the increase and is charged proportionally rather than re-charged
    //              on the whole balance.
    //
    // Every read is bounded by this block's own time, so two nodes processing the same
    // block compute the same fee and reach the same verdict. The validator coin price is
    // anchored at BLOCK_TIME (not at the oracle row's effective time, which is what
    // SETTLEMENT uses) because this fee is a charge levied at the create moment, not a
    // reconstruction of what a buyer saw.
    //
    // Returns { valid, error?, expectedFee, paidAmount?, belowDust? }.
    // How much oracle fee a dispenser open/refill owes, WITHOUT looking at any output.
    //
    // Deliberately the single source of truth for the amount: validateOracleFee (the
    // consensus check) and the oraclefeequote API (what a payer sizes its output from)
    // both call this. If the quote and the check computed the amount separately they
    // could drift, and every drift is either a rejected honest create or an underpaid
    // oracle. Same reason getFeeOraclePrices is shared by the native-fee check and its
    // pre-flight.
    //
    // Returns { valid, error?, expectedFee (bignumber), belowDust? }.
    async quoteOracleFee(blockTime, dispenser, db){
        blockTime = Number(blockTime);

        // The oracle must already have an EFFECTIVE price. Shared with the standalone
        // create-time precondition (requireEffectiveOraclePrice above) so the two cannot
        // drift: one rule, one error string, one lookup.
        let priceCheck = await this.requireEffectiveOraclePrice(blockTime, dispenser, db);
        if(!priceCheck.valid)
            return { valid: false, error: priceCheck.error };
        let oracleRow = priceCheck.oracleRow;

        // A zero or absent FEE is the common case and requires no output at all.
        let feeFraction = this.bcnum(oracleRow.fee || 0);
        if(this.bclte(feeFraction, 0))
            return { valid: true, expectedFee: this.bcnum(0), belowDust: true };

        // Validator COIN/FIAT price for the coin the buyer will pay in, same pair
        // settlement uses (GET_COIN, not GIVE_COIN - see reverseOraclePriceMatch).
        let window   = parseInt(this.config['FIAT_DISPENSER_PRICE_WINDOW']) || 86400;
        let coinPair = dispenser['GET_COIN'] + '/' + dispenser['FIAT_CODE'];
        let priceDb  = (db.indexer && db.indexer.hubDb) ? db.indexer.hubDb : db;
        let snapshots = await priceDb.getPricesInTimeRange(coinPair, blockTime - window, blockTime);
        if(!snapshots || snapshots.length === 0)
            return { valid: false, error: 'invalid: ORACLE_ADDRESS (no validator price to value the oracle fee)' };

        let expectedFee = this.computeOracleFee(
            oracleRow.value, dispenser['GIVE_ESCROW'], snapshots[0].price, feeFraction);

        // Below dust the output would be unspendable, so none is required. Mirrors
        // Counterparty skipping the output below DEFAULT_REGULAR_DUST_SIZE.
        return { valid: true, expectedFee: expectedFee,
                 belowDust: this.bclt(expectedFee, this.getDustThresholdCoin()) };
    },

    async validateOracleFee(data, dispenser, db){
        let oracleAddress = dispenser['ORACLE_ADDRESS'];

        let quote = await this.quoteOracleFee(data['BLOCK_TIME'], dispenser, db);
        if(!quote.valid) return quote;

        let expectedFee = quote.expectedFee;
        // Nothing is owed and no output is read, so this path spends none of the batch's
        // oracle-fee pool and deliberately touches no tally. It stays ABOVE the pool
        // arithmetic below for the same reason the zero-fee native path does: a command
        // that owes nothing must never be invalidated by what its siblings spent.
        if(quote.belowDust)
            return { valid: true, expectedFee: this.bcformat(expectedFee, 8),
                     belowDust: true };

        // Same output matcher as validateNativeCoinFee: first output paying the address.
        let feeOutput = findFeeOutput(data['TX_OUTPUTS'], oracleAddress);
        if(!feeOutput)
            return { valid: false, error: 'invalid: ORACLE_ADDRESS (missing oracle fee output)',
                     expectedFee: this.bcformat(expectedFee, 8) };

        return drawOracleFeeOutput(this, data, oracleAddress, expectedFee, feeOutput);
    }
};
