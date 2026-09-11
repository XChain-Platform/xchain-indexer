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
 * Amount representability flag-day: an AMOUNT must denote the number the
 * ledger will actually store, not merely look like an amount.
 *
 * WHAT IS BROKEN. utility.js isValidAmountFormat validates amount TEXT. It
 * splits on '.', asks isNumeric() of each half, and caps the fractional half's
 * DIGIT COUNT at the tick's decimals. isNumeric() accepts everything the
 * JavaScript number grammar accepts, so the text that reaches the bignumber
 * ledger math is not restricted to a plain decimal numeral. Measured against
 * this tree (INDEXER_COIN=BTC, INDEXER_NETWORK=regtest):
 *
 *   isValidAmountFormat(18, '5e-19')  -> true, and bcadd('5e-19', 0, 18)
 *                                        credits '1e-18'. The validator saw
 *                                        a 4-character "fraction" ('e-19'),
 *                                        well inside 18, and the number that
 *                                        was credited is not the number that
 *                                        was checked.
 *   isValidAmountFormat(0,  '1e-1')   -> true on an INDIVISIBLE tick, and
 *                                        bcadd('1e-1', 0, 0) credits '0'.
 *                                        The whole point of decimals=0 is that
 *                                        a fractional amount cannot be spelled.
 *   isValidAmountFormat(8,  '0x10')   -> true (hex), '0b101' -> true (binary),
 *                                        '1e+5' -> true, '+1.5' -> true,
 *                                        '1.5 ' -> true (trailing space),
 *                                        '1.' -> true.
 *   isValidAmountFormat(18, '1'x43)   -> true. Forty-three integer digits do
 *                                        not fit DECIMAL(60,18), whose integer
 *                                        capacity is 60-18 = 42 digits, so the
 *                                        ledger aggregation that sums amounts
 *                                        at that scale (db.js supply and
 *                                        escrow sums, ledger_amount_precision_
 *                                        activation.js) overflows or truncates
 *                                        rather than reporting the value that
 *                                        was validated.
 *
 * Every one of those is the same defect: the validator's answer is about the
 * string, and the credit is about a different number.
 *
 * THE RULE, when active. The amount text must be a plain unsigned decimal
 * numeral - digits, optionally one '.' followed by at least one digit - whose
 * integer part fits the ledger's DECIMAL(60,18) integer capacity. No exponent,
 * no sign, no radix prefix, no whitespace, no empty half. Everything else the
 * legacy function rejects it still rejects: this gate can only ever reject
 * MORE, never accept more (isValidAmountFormat applies it as an extra early
 * return false and leaves the legacy body untouched), which is what makes the
 * "byte-identical below the threshold" claim mechanical rather than a review
 * judgement.
 *
 * Leading zeros ('007', '0.5') stay VALID. They are exactly representable and
 * bcadd normalizes them; rejecting them would be a canonical-form rule, which
 * is a different question from representability and is not this gate's scope.
 * Trailing fractional zeros ('1.50000000') likewise stay valid - the existing
 * suite asserts them and the ledger stores them at tick scale.
 *
 * WHY 42 INTEGER DIGITS. It is the integer capacity of DECIMAL(60,18), the
 * widest scale any consensus aggregation in this tree casts to, and 42 + 18 =
 * 60 significant digits also sits inside the house-wide mathjs bignumber
 * precision of 64 that every bc* path runs at (utility.js bcmuldivfloor). The
 * largest amount the protocol can legitimately mint is MAX_TOKEN_SUPPLY =
 * 1e21 (22 digits, config.js), so the cap is two orders of magnitude of
 * headroom above anything reachable and only bites on values that were never
 * going to survive the ledger anyway.
 *
 * WHY IT MUST BE GATED. Rejecting an action the engine used to accept
 * re-evaluates already-processed blocks, so replay of committed history would
 * diverge on any block that carried such an amount. The rule is therefore keyed
 * on the block's consensus timestamp (data['BLOCK_TIME']); below the threshold
 * the legacy acceptance runs and historical replay is byte-identical.
 *
 * MAINNET AND TESTNET ARE BOTH UNARMED (house sentinel 9999999999, the one
 * price_pair_activation.js and the protocol_changes.js cohort use). Mainnet is
 * unarmed per the standing operator hold on mainnet writes. Testnet is unarmed
 * because testnet is PUBLICLY LAUNCHED with live committed ledgers, so arming
 * it from genesis would retroactively re-judge real history; the arm needs a
 * measured OLD-vs-ON replay witness against the live testnet databases, which
 * is a read this module cannot make for itself. Regtest is genesis-active,
 * which is what the from-genesis replay-equivalence run exercises.
 *
 * SDK MIRROR IS DELIBERATELY NOT SHIPPED YET. xchain-sdk carries its own
 * isValidAmountFormat for client-side pre-submission checks, kept behaviourally
 * in step by test/integration/scenarios/15-sdk-parity.test.js. Mirroring this
 * rule into the SDK before mainnet arms would make the CLIENT stricter than the
 * consensus-authoritative indexer, which rejects amounts the chain would still
 * accept - a client-side fork of the acceptance set. The mirror ships with the
 * mainnet arm, not before; until then the SDK's two-argument calls hit the
 * legacy path here too, so the parity suite stays green by construction.
 *
 * Registered as a standalone twin-style module rather than a
 * protocol_changes.addChange entry, matching dispense_cancelling_match_
 * activation.js and dispenser_amount_positivity_activation.js: isEnabled() is
 * async and DB-backed, and isValidAmountFormat is a synchronous predicate on
 * 25 call sites across 16 files, so an addChange entry would force that whole
 * validation surface async for no consensus benefit.
 *
 * Execution-path gate (action acceptance), not a hashing-path change, so
 * indexer-only with no xchain-sync twin.
 *
 ********************************************************************/

// Per-network activation, interpreted against the block's consensus timestamp
// (data['BLOCK_TIME']).
const AMOUNT_REPRESENTABILITY_ACTIVATION = {
    mainnet: 9999999999,    // UNARMED (house sentinel, year 2286): mainnet writes are held
    testnet: 9999999999,    // UNARMED (house sentinel): live launched history, arm needs a measured replay witness
    regtest: 0,
};

// Integer capacity of DECIMAL(60,18), the widest scale the consensus
// aggregations cast to. See the WHY 42 INTEGER DIGITS note above.
const AMOUNT_MAX_INTEGER_DIGITS = 42;

// A plain unsigned decimal numeral: digits, optionally one '.' and at least one
// more digit. Anchored, so exponent notation, signs, radix prefixes, whitespace
// and empty halves all fail.
const PLAIN_DECIMAL = /^[0-9]+(\.[0-9]+)?$/;

// Whether `text` denotes a number the ledger can store at `decimals` without the
// credited value differing from the validated text. Pure text/shape rule,
// independent of the activation threshold, so callers and tests can reason about
// the rule and about WHEN it binds separately.
//
// TAKES ALREADY-RENDERED TEXT, not a raw wire value. The caller renders with
// utility.js safeToString, which is the tree's existing definition of "a value we
// may stringify": it formats a mathjs bignumber in FIXED notation and returns null
// for anything unstringifiable. That matters twice. Legitimate merged amounts
// arrive here as bignumber OBJECTS (the SEND/DESTROY leg merge hands bcadd's
// return value straight to the validator), and a bare typeof check refused every
// one of them - measured, as five red cases in
// test/unit/actions/consolidation-leg-amount.test.js on the first run. And a plain
// String() on a bignumber can render exponent notation, which would have made the
// rule reject the very values it is meant to certify. Deciding object handling in
// safeToString rather than here also keeps this gate strictly a tightening: the
// legacy body already accepts an object whose safeToString is a numeral, and this
// rule does not change that.
function isRepresentableAmount(decimals, text){
    // safeToString returns null for null, undefined and unstringifiable objects.
    if(typeof text != 'string')
        return false;
    if(!PLAIN_DECIMAL.test(text))
        return false;
    let parts = text.split('.');
    let int   = parts[0];
    let sats  = parts[1];
    // Count SIGNIFICANT integer digits: '007' is 1 digit of value, and leading
    // zeros are exactly representable (see the note above).
    let significant = int.replace(/^0+/, '');
    if(significant.length > AMOUNT_MAX_INTEGER_DIGITS)
        return false;
    // An indivisible tick has no fractional grid at all; a divisible one is
    // capped at its own decimals. The legacy body caps the divisible case too,
    // but stating it here keeps the rule readable on its own.
    let d = parseInt(decimals);
    if(!Number.isFinite(d))
        return false;
    if(sats !== undefined && sats.length > d)
        return false;
    return true;
}

// Whether the representability rule binds for a block whose consensus timestamp
// is `blockTime` on `network`. Below the threshold -> off (legacy acceptance,
// byte-identical historical replay). Unknown network -> off (safe: keeps
// deployed behavior; boot rejects invalid networks before any block is
// processed).
function isAmountRepresentabilityActive(blockTime, network){
    let t = parseInt(blockTime);
    if(!Number.isFinite(t)) return false;
    let threshold = AMOUNT_REPRESENTABILITY_ACTIVATION[network];
    if(threshold === undefined) return false;
    return t >= threshold;
}

module.exports = {
    AMOUNT_REPRESENTABILITY_ACTIVATION,
    AMOUNT_MAX_INTEGER_DIGITS,
    isRepresentableAmount,
    isAmountRepresentabilityActive
};
