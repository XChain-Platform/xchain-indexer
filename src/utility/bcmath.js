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
 * XChain Indexer - Utility: bignumber math
 *
 * The bc* amount math every handler uses: mathjs bignumbers carried at an explicit
 * precision, with the floor, round and saturating variants consensus pins.
 *
 ********************************************************************/

'use strict';

const mathjs = require('mathjs');

// Installed onto Utility.prototype by ../utility.js, non-enumerable; each method runs with
// `this` bound to the Utility instance, exactly as the class method it was.
module.exports = {

    // Handle converting a string number to a mathjs bignumber for full precision
    bcnum(num){
        let str = String(num).trim();
        if(str === 'NaN' || str === 'Infinity' || str === '-Infinity' || !this.isNumeric(num))
            return mathjs.bignumber(0);
        return mathjs.bignumber(str);
    },

    // Render a big number as a plain decimal string in normal (never exponential)
    // notation. String()/toString() on a decimal.js-backed bignumber switches to
    // exponential below 1e-7 (e.g. "3e-8"), which the SMT leaf encoder rejects
    // (merkle canonicalAmount) and which drifts the stored byte-form from the
    // sync twin. toFixed() without dp is byte-identical to toString() for every
    // normal-range value, so amounts already stored are unaffected.
    bcstr(num){
        return this.bcnum(num).toFixed();
    },

    // Render an amount for a CONSOLE LOG line without exponential notation.
    //
    // Action loggers interpolate amounts straight into a template, and by the time
    // they run setNumberFormats has replaced the parsed string with a bignumber,
    // whose String()/toString() flips to exponential below 1e-7. So a valid
    // 0.00000003 destroy/order/send printed as "3e-8" in the indexer log - the
    // operator-facing record of what the chain did - even though the stored and
    // hashed byte-form was correct (those paths already go through bcstr).
    //
    // Deliberately NOT bcstr: bcstr coerces anything non-numeric to "0", and these
    // sites legitimately print undefined/null/'' for a field an invalid action never
    // supplied. Turning that into "0" would read as a real zero amount.
    //
    // Only a value that ALREADY renders exponentially is rewritten, so every other
    // log line stays byte-identical to what it printed before. A blanket
    // bignumber round-trip would also normalize plain strings ('1.50' -> '1.5'),
    // silently disagreeing with the amount as the action supplied it.
    logAmount(value){
        let str = String(value);
        if(str.indexOf('e')==-1 && str.indexOf('E')==-1)
            return str;
        if(!this.isNumeric(value))
            return str;
        return this.bcnum(value).toFixed();
    },

    // Handle returning a number to a given decimal point precision
    bcformat(num, decimals){
        let d = (!this.isNull(decimals)) ? parseInt(decimals) : 0;
        return mathjs.format(this.bcnum(num),{notation: 'fixed', precision: d});
    },

    // Handle subtracting 2 big numbers
    bcsub(numA, numB, decimals){
        let a = (!this.isNull(numA)) ? numA : 0;
        let b = (!this.isNull(numB)) ? numB : 0;
        let d = (!this.isNull(decimals)) ? parseInt(decimals) : 0;
        return this.bcnum(mathjs.format(mathjs.subtract(mathjs.bignumber(a),mathjs.bignumber(b)),{notation: 'fixed', precision: d}));
    },

    // Handle adding 2 big numbers
    bcadd(numA, numB, decimals){
        let a = (!this.isNull(numA)) ? numA : 0;
        let b = (!this.isNull(numB)) ? numB : 0;
        let d = (!this.isNull(decimals)) ? parseInt(decimals) : 0;
        return this.bcnum(mathjs.format(mathjs.add(mathjs.bignumber(a),mathjs.bignumber(b)),{notation: 'fixed', precision: d}));
    },

    // Handle multiplying 2 big numbers
    bcmul(numA, numB, decimals){
        let a = (!this.isNull(numA)) ? numA : 0;
        let b = (!this.isNull(numB)) ? numB : 0;
        let d = (!this.isNull(decimals)) ? parseInt(decimals) : 0;
        return this.bcnum(mathjs.format(mathjs.multiply(mathjs.bignumber(a),mathjs.bignumber(b)),{notation: 'fixed', precision: d}));
    },

    // Multiply two bignumber strings and floor the result to d decimal places.
    // Uses Decimal.js native .floor() (via bcnum) to avoid mathjs.format()'s
    // rounding, which credits holders more than their strict proportional
    // entitlement at midpoint fractional values.
    //
    // That rounding is HALF-UP (away from zero), NOT banker's/half-even, which
    // earlier revisions of this comment claimed. Measured: at 8 decimals
    // '0.000000025' -> '0.00000003' (half-even would give '0.00000002'), and at
    // 0 decimals '2.5' -> '3', '3.5' -> '4', '-2.5' -> '-3'. The correction makes
    // the case for flooring STRONGER, not weaker: half-even would at least split
    // midpoint ties evenly, while half-up rounds every one of them up, so the
    // over-credit accumulates in one direction across a payout set.
    bcmulfloor(numA, numB, decimals){
        let a = (!this.isNull(numA)) ? numA : 0;
        let b = (!this.isNull(numB)) ? numB : 0;
        let d = (!this.isNull(decimals)) ? parseInt(decimals) : 0;
        let product = mathjs.multiply(mathjs.bignumber(a), mathjs.bignumber(b));
        let scale = mathjs.bignumber(10).pow(d);
        let floored = this.bcnum(product).times(scale).floor().div(scale);
        return this.bcnum(mathjs.format(floored, {notation: 'fixed', precision: d}));
    },

    // floor(A * B / C) at d decimal places, entirely in decimal.js space. Backs the
    // BET parimutuel payout (stake * pot / winning-pool, floored to the tick's
    // decimals): floor keeps
    // sum(payouts) <= pot exactly, so the escrow-conservation invariant holds and
    // rounding remainders land in the oracle's dust credit rather than minting.
    // Determinism: the product and quotient are computed at the house-wide mathjs
    // bignumber precision (64 significant digits) that every consensus math path
    // already uses (bcdiv/getPrice), then floored with Decimal.js native .floor()
    // like bcmulfloor (never mathjs.format's half-up rounding). Every node runs
    // the same arithmetic at the same precision, so results are node-identical by
    // construction. C = 0 returns 0 (bcdiv convention).
    bcmuldivfloor(numA, numB, numC, decimals){
        let a = (!this.isNull(numA)) ? numA : 0;
        let b = (!this.isNull(numB)) ? numB : 0;
        let c = (!this.isNull(numC)) ? numC : 0;
        let d = (!this.isNull(decimals)) ? parseInt(decimals) : 0;
        if(String(c) === '0' || c === 0)
            return this.bcnum(mathjs.format(mathjs.bignumber(0), {notation: 'fixed', precision: d}));
        let product  = mathjs.multiply(mathjs.bignumber(a), mathjs.bignumber(b));
        let quotient = this.bcnum(mathjs.divide(product, mathjs.bignumber(c)));
        let scale    = mathjs.bignumber(10).pow(d);
        let floored  = quotient.times(scale).floor().div(scale);
        return this.bcnum(mathjs.format(floored, {notation: 'fixed', precision: d}));
    },

    // Round a bignumber to d decimal places, half-up, entirely in decimal.js space.
    // Implemented as floor(n * 10^d + 0.5) / 10^d so the rounding mode is explicit and
    // config-independent: it does NOT depend on the global decimal.js/mathjs rounding
    // setting (the same determinism concern that motivated bcmulfloor and the exact bc*
    // comparators). It snaps a derived settlement amount onto its tick's decimal grid:
    // it recovers the true value from sub-ULP precision artifacts (e.g. 1 − 1e-18 =
    // 0.999999999999999999 → 1) and forces indivisible (0-decimal) tokens to integers.
    bcround(num, decimals){
        let n = (!this.isNull(num)) ? num : 0;
        let d = (!this.isNull(decimals)) ? parseInt(decimals) : 0;
        let scale   = mathjs.bignumber(10).pow(d);
        let half    = mathjs.bignumber('0.5');
        let rounded = this.bcnum(n).times(scale).plus(half).floor().div(scale);
        return this.bcnum(mathjs.format(rounded, {notation: 'fixed', precision: d}));
    },

    // Square root of a non-negative big number, TRUNCATED (not rounded) to d
    // decimals. sqrt is irrational, so a fixed-precision truncation is
    // consensus-critical: every node must derive identical weights. Computed in
    // decimal.js space (mathjs bignumber is decimal.js-backed) then floored at
    // 10^d, the same discipline as bcmulfloor. Backs the quadratic VOTE weight
    // mode (weight = sqrt(close_balance)); negative input clamps to 0 (balances
    // are non-negative, this is just a guard).
    bcsqrt(num, decimals){
        let n = (!this.isNull(num)) ? num : 0;
        let d = (!this.isNull(decimals)) ? parseInt(decimals) : 0;
        let base = this.bcnum(n);
        if(base.lt(0)) return mathjs.bignumber(0);
        let scale = mathjs.bignumber(10).pow(d);
        let trunc = base.sqrt().times(scale).floor().div(scale);
        return this.bcnum(mathjs.format(trunc, {notation: 'fixed', precision: d}));
    },

    // Handle dividing 2 big numbers
    bcdiv(numA, numB, decimals){
        let a = (!this.isNull(numA)) ? numA : 0;
        let b = (!this.isNull(numB)) ? numB : 0;
        let d = (!this.isNull(decimals)) ? parseInt(decimals) : 0;
        if(String(b) === '0' || b === 0)
            return mathjs.bignumber(0);
        return this.bcnum(mathjs.format(mathjs.divide(mathjs.bignumber(a),mathjs.bignumber(b)),{notation: 'fixed', precision: d}));
    },

    // Floor a bignumber to a JS integer in bignumber space; avoids the
    // Math.floor(Number(bignumber)) trap where the implicit Number() coercion
    // goes through IEEE 754 and can round a value like 2.9999…964 down to 2
    // instead of returning the correct 3. Note: uses decimal.js's native
    // .floor(), NOT mathjs.floor() (the latter is configured with a default
    // precision that rounds 137.99999999999 up to 138.
    bcfloor(num){
        // Floor in exact bignumber space, then guard the JS-Number conversion:
        // .toNumber() above Number.MAX_SAFE_INTEGER (2^53-1) silently rounds to a
        // nearby double, corrupting a value that then flows into consensus math.
        // Mirror the encoder's parseSatoshiAmount fail-fast: throw loudly rather
        // than return a lossy integer (covers the rawTokens/rawMultiplier unit
        // math at :1964/:1991, and dispense.js's GIVE_REMAINING clamp, which is
        // reached only when capacity is already below an in-range multiplier).
        // Every dispenser FILL count uses bcfloorSaturating instead: those ratios
        // are attacker-reachable, and a throw on the block-processing path wedges
        // the block loop rather than rejecting one action.
        const floored = this.bcnum(num).floor();
        if(floored.gt(Number.MAX_SAFE_INTEGER))
            throw new RangeError(`bcfloor result (${floored.toString()}) exceeds the maximum safe integer (${Number.MAX_SAFE_INTEGER}) and cannot be represented without precision loss`);
        return floored.toNumber();
    },

    // bcfloor, but saturating at Number.MAX_SAFE_INTEGER instead of throwing.
    //
    // For every dispenser fill count, FIAT and non-FIAT alike. The FIAT ones are
    //   Mode A: coin_amount / (FIAT_AMOUNT / coin_price)
    //   Mode B: (coin_amount * coin_price) / oracle_price
    // which scale with an externally-chosen price and can run many orders of
    // magnitude higher than the payment. PRICE v1 validates VALUE only as a
    // positive 8-decimal string (actions/price.js), so a 0.00000001 quote on a
    // high-magnitude fiat pair pushes the count past 2^53-1 for well under one
    // coin of payment, sent to an address the dispenser operator controls: the
    // coin comes straight back and the attack costs a transaction fee.
    //
    // Scoping the helper to FIAT ONLY would rest on the premise that the non-FIAT
    // coin_amount / GET_AMOUNT cannot run that high. That premise is
    // false: GET_AMOUNT is validated only against GET_TICK's DECIMALS, a tick may
    // be issued with up to MAX_TOKEN_DECIMALS (18), and the token-SEND trigger
    // channel puts an attacker-chosen SEND amount in COIN_AMOUNT
    // (processDispenserSends), so a 1e-18 price against a ~0.01 SEND clears 2^53-1
    // for two cheap transactions. dispense.js's non-FIAT branch saturates for that
    // reason.
    //
    // Throwing there is worse than saturating. A throw on the block-processing
    // path rolls the block back and the loop retries the SAME block forever (the
    // wedge shape recorded in the protocol_changes.js constructor comment about
    // this.version.split), taking every indexer on the chain down with it.
    //
    // Saturating is safe because the caller immediately clamps the multiplier to
    // the dispenser's real capacity, floor(GIVE_REMAINING / GIVE_AMOUNT), which
    // is smaller than this ceiling for any plausible dispenser: the two paths
    // land on the same verdict. Where capacity itself exceeds the ceiling the
    // saturated count is a documented bound rather than an equivalence, and it
    // needs no activation gate either way, because the behavior it replaces was
    // "no node commits anything for this block".
    bcfloorSaturating(num){
        const floored = this.bcnum(num).floor();
        if(floored.gt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER;
        return floored.toNumber();
    },

    // Handle comparing two big numbers: returns true if numA > numB
    //
    // Uses decimal.js's native .gt/.lt/.gte/.lte (exact) rather than
    // mathjs.larger/smaller/largerEq/smallerEq, which apply mathjs's comparison
    // epsilon (~1e-12) and treat any two amounts differing by less than that as
    // EQUAL. For 18-decimal tokens that silently corrupts every comparison of
    // sub-1e-12 amounts: e.g. bcgt('0.000000000000001', '0') returned false,
    // so a dust balance read as "not greater than zero". These must be exact.
    bcgt(numA, numB){
        return this.bcnum(numA).gt(this.bcnum(numB));
    },

    // Handle comparing two big numbers: returns true if numA < numB
    bclt(numA, numB){
        return this.bcnum(numA).lt(this.bcnum(numB));
    },

    // Handle comparing two big numbers: returns true if numA >= numB
    bcgte(numA, numB){
        return this.bcnum(numA).gte(this.bcnum(numB));
    },

    // Handle comparing two big numbers: returns true if numA <= numB
    bclte(numA, numB){
        return this.bcnum(numA).lte(this.bcnum(numB));
    }
};
