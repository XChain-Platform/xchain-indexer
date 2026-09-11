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
 * Token-payment dispense tally scale flag-day.
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
 * THE RULE. When active, the LOCAL (non-batch) tally for a token-denominated
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
 * scale settles identically above and below this gate. Only the sub-satoshi
 * amounts the defect actually misprices move, which is what keeps the flag day
 * narrow.
 *
 * IT IS STILL CONSENSUS-AFFECTING, which is why it is gated: it changes the
 * fill count a payment buys, so a valid dispense becomes a refusal and the
 * credits and escrow debits that dispense would have written are not written.
 * Those rows are block-hash preimages. Below the threshold the 8 dp tally runs
 * untouched and historical replay stays byte-identical.
 *
 * MAINNET IS ARMED AT GENESIS (operator ruling 2026-09-09), alongside
 * dispenser_amount_positivity_activation and
 * consolidation_leg_amount_activation. An activation instant in the past
 * re-prices committed blocks only where there are priced blocks to re-price,
 * and the audit this arming waited on has now been taken: read-only against
 * the live indexer databases on 2026-09-09, mainnet holds 0 dispensers and 0
 * dispenses, so no token-triggered dispense has ever settled there and the
 * exact tally is the identity function over every mainnet block committed so
 * far. BATCH_ISSUANCE_LIMITS arming mainnet at 2026-08-16 exposed the
 * defective tally but nothing exercised it. The proof is a per-chain OLD-vs-ON
 * replay witness, not this comment. testnet/regtest run from genesis, matching
 * every dispenser-family activation.
 *
 * Execution-path gate (action settlement), not a hashing-path change, so
 * indexer-only with no xchain-sync twin: xchain-sync replicates materialized
 * rows and never runs an action handler.
 *
 ********************************************************************/

// Scale the tally is kept at once the rule is live. 18 is
// config.MAX_TOKEN_DECIMALS, the finest precision any tick can be issued with,
// and the scale ledger_amount_precision_activation and the balance projections
// already net in. Deliberately a local constant rather than an import: an edit
// to another gate's scale must not silently re-price blocks above this height.
const DISPENSE_TALLY_EXACT_SCALE = 18;

// The scale the tally has always used, and the scale a native-coin payment
// keeps. Also the render width of the dispenses row below.
const DISPENSE_TALLY_LEGACY_SCALE = 8;

// Per-network activation, interpreted against the block's consensus timestamp
// (data['BLOCK_TIME']), matching the dispenser-family cohort.
const DISPENSE_PAYMENT_TALLY_SCALE_ACTIVATION = {
    mainnet: 0,             // ARMED at genesis by the 2026-09-09 ruling: identity on the indexed mainnet history (0 dispensers, 0 dispenses, measured 2026-09-09)
    testnet: 0,
    regtest: 0,
};

// Whether the exact token-payment tally binds for a block whose consensus
// timestamp is `blockTime` on `network`. Below the threshold -> off (8 dp
// tally, byte-identical historical replay). Unknown network or unparseable
// timestamp -> off (safe: keeps deployed behavior).
function isDispensePaymentTallyScaleActive(blockTime, network){
    let t = parseInt(blockTime);
    if(!Number.isFinite(t)) return false;
    let threshold = DISPENSE_PAYMENT_TALLY_SCALE_ACTIVATION[network];
    if(threshold === undefined) return false;
    return t >= threshold;
}

// The scale the dispense payment tally should run at for a given block.
//
// `tokenDenominated` is the caller's answer to "is COIN_AMOUNT a token amount",
// and `batchScoped` to "is this the shared batch pool". Both false-ish answers
// keep the legacy scale, so a caller that cannot tell stays on deployed
// behavior.
function dispenseTallyScale(blockTime, network, tokenDenominated, batchScoped){
    if(!tokenDenominated || batchScoped)
        return DISPENSE_TALLY_LEGACY_SCALE;
    if(isDispensePaymentTallyScaleActive(blockTime, network))
        return DISPENSE_TALLY_EXACT_SCALE;
    return DISPENSE_TALLY_LEGACY_SCALE;
}

module.exports = {
    DISPENSE_TALLY_EXACT_SCALE,
    DISPENSE_TALLY_LEGACY_SCALE,
    DISPENSE_PAYMENT_TALLY_SCALE_ACTIVATION,
    isDispensePaymentTallyScaleActive,
    dispenseTallyScale
};
