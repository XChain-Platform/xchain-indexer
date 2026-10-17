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
 * Token-payment dispense tally scale.
 *
 * THE DEFECT. actions/dispense.js keeps the non-batch payment tally at 8 dp:
 * `available` is bcsub(COIN_AMOUNT, consumed, 8), a fill's charge is
 * bcmul(multiplier, unitCoinCost, 8), and the pool accumulates at 8 dp. That
 * scale is right for a native-coin payment and wrong for a token-triggered
 * one. util.processDispenserSends puts the SEND's OWN amount in COIN_AMOUNT,
 * denominated in the sent tick, and a tick may be issued with up to
 * config.MAX_TOKEN_DECIMALS (18); a dispenser's GET_AMOUNT is validated only
 * against its GET_TICK's decimals, so the unit price can be sub-satoshi too.
 * The bc helpers ROUND half-up at the requested scale, so both ends of the
 * tally move:
 *
 *   OVER-ISSUANCE. A charge below half a satoshi renders as zero, the pool
 *   never drains, and every dispenser behind the paid address fills off the
 *   same payment. That is exactly the one-payment-N-settlements defect the
 *   batch-issuance tally was minted to close, still fully open for a
 *   high-decimal tick. Measured: a 0.00000001 payment against three
 *   dispensers priced at 0.000000004 a fill settles all three (a true cost of
 *   0.000000012) with the pool reading 0.00000000.
 *
 *   OVER-CHARGE. A charge just above half a satoshi rounds UP, so a buyer is
 *   billed for value they did not spend and a sibling dispenser they had paid
 *   for is refused. Measured: a 0.00000001 payment, one fill at 0.000000006
 *   and one at 0.000000004, drains the whole payment on the first and refuses
 *   the second.
 *
 * THE RULE. The LOCAL (non-batch) tally for a token-denominated
 * payment is kept at DISPENSE_TALLY_EXACT_SCALE (18), so no subtraction,
 * multiplication or accumulation in the tally rounds. Nothing else changes:
 * the pricing divides already run at 64 dp, and the fill count, the ownership
 * cap and the GIVE_REMAINING clamp are untouched.
 *
 * SCOPE, and what is deliberately NOT in it:
 *   - The BATCH pool (data['BATCH_VALUE_LEDGER']) stays at 8 dp. It counts the
 *     TRANSACTION's coin settlement value, it is shared with actions/coinpay.js
 *     and validateOracleFee, and all three format it the same way; widening one
 *     reader's scale would split a shared contract.
 *   - A native-coin trigger stays at 8 dp. Its payment and its price are both
 *     coin amounts, which the scale already holds exactly.
 *
 * A NO-OP ON EVERY 8 dp PAYMENT, BY VALUE. bcsub/bcmul/bcadd at 18 dp agree
 * exactly with the same call at 8 dp whenever both operands are representable
 * at 8 dp, so a token dispense whose payment and unit price fit the native
 * scale settles identically. Only the sub-satoshi amounts the defect actually
 * misprices move.
 *
 ********************************************************************/

const { copy } = require('../../consensus/gate_registry');

const DISPENSE_TALLY_EXACT_SCALE = copy('dispense_payment_tally_scale_activation.DISPENSE_TALLY_EXACT_SCALE');

const DISPENSE_TALLY_LEGACY_SCALE = copy('dispense_payment_tally_scale_activation.DISPENSE_TALLY_LEGACY_SCALE');

// The scale the dispense payment tally should run at.
//
// `tokenDenominated` is the caller's answer to "is COIN_AMOUNT a token amount",
// and `batchScoped` to "is this the shared batch pool". Both false-ish answers
// keep the legacy scale, so a caller that cannot tell stays on deployed
// behavior.
//
// `fiatPricingExact` is dispenser_fiat_pricing_activation at this block. It
// extends the exact scale to a non-batch COIN payment: a FIAT fill (Mode A
// FIAT_AMOUNT / price, Mode B the oracle-priced cost) can cost under a satoshi,
// and at 8 dp such a fill drains nothing, so the next dispenser behind the
// address prices against the whole payment again. A coin payment priced in whole
// satoshis settles identically at either scale, as above.
function dispenseTallyScale(tokenDenominated, batchScoped, fiatPricingExact){
    if(batchScoped)
        return DISPENSE_TALLY_LEGACY_SCALE;
    if(!tokenDenominated)
        return fiatPricingExact ? DISPENSE_TALLY_EXACT_SCALE : DISPENSE_TALLY_LEGACY_SCALE;
    return DISPENSE_TALLY_EXACT_SCALE;
}

module.exports = {
    DISPENSE_TALLY_EXACT_SCALE,
    DISPENSE_TALLY_LEGACY_SCALE,
    dispenseTallyScale
};
