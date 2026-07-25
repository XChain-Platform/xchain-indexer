/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * PRICE v0 pair-name widening flag-day .
 *
 * A PRICE v0 round names each pair TICKER/FIAT. The ticker side has always been
 * bounded to 5 characters, and the gas ticker XCHAIN is 6, so the XCHAIN/USD pair
 * that every native-coin fee decision needs (utility.getFeeOraclePrices) cannot be
 * expressed on the wire at all. At/above this gate the ticker side accepts 6
 * characters; below it the legacy 5-character bound is preserved verbatim so replay
 * stays bit-identical.
 *
 * CONSENSUS. Below the gate a round carrying XCHAIN/USD is invalid on every node;
 * at/above it, valid on every node. A one-sided deploy forks the fleet on the first
 * such round.
 *
 * TIME-keyed, not height-keyed. A PRICE v0 action is parsed by the indexer of
 * whichever chain carried it, and BTC/LTC/DOGE heights diverge, so no single height
 * names one cutover. Same rationale protocol_changes.js records for
 * FIX_OUTPUT_FANOUT.
 *
 * ONLY THE TICKER SIDE WIDENS. No FIAT_CODE exceeds 3 characters
 * (constants.js VALID_FIAT_CODES), so widening the fiat side would admit nothing
 * legitimate and only loosen a bound this site does not otherwise validate.
 *
 * WHY THERE IS NO PER-ENTRY-DROP BEHAVIOUR HERE. A malformed pair invalidates the
 * WHOLE action, before and after this gate, and that is correct rather than a
 * defect to fix: the pair set is inside the signed payload
 * (ed25519.buildPriceV0Payload reconstructs the signable bytes FROM the parsed
 * pairs), so skipping one entry changes the payload, fails every signature, and
 * rejects the round anyway with a less informative error. A signed round is atomic.
 * This gate therefore changes exactly one thing: which pairs are well-formed.
 *
 * DEPLOY ORDER IS PART OF THIS GATE. Widen every hub and every indexer FIRST, while
 * nothing proposes the pair; only then may a leader include XCHAIN/USD in a round.
 * Reversed, the hub's co-sign whitelist and round ingest reject the whole round,
 * which stalls ALL 36 pairs federation-wide and fails fee validation on every chain
 * once the 1800s staleness bound elapses.
 *
 * LOCAL COPY of the canonical map in
 * xchain-documentation/protocol/constants.js (PRICE_PAIR_WIDEN_ACTIVATION);
 * kept value-identical by test/unit/activationConstantsParity.test.js. A one-sided
 * edit forks PRICE v0 accept/reject at the flag-day.
 *
 ********************************************************************/

'use strict';

// Ticker-side bounds either side of the gate (LOCAL COPY, see header).
const PRICE_PAIR_TICKER_MAX_LEGACY = 5;
const PRICE_PAIR_TICKER_MAX_WIDE   = 6;

// Per-network activation TIME (LOCAL COPY of the canonical map in
// xchain-documentation/protocol/constants.js). Keyed on the action's own block time.
//
// UNARMED on mainnet: 9999999999 is a far-future sentinel (year 2286), NOT a
// scheduled flag-day.  D6, the pre-launch instant this arms at, is an open
// operator decision; the usual contract-era stamp 1790812800 (2026-10-01) is not
// usable because it falls AFTER the early-September launch target and would leave
// LTC/DOGE native-coin fees unpayable straight through launch.
const PRICE_PAIR_WIDEN_ACTIVATION = {
    mainnet: 9999999999,  // UNARMED sentinel - see  D6
    testnet: 0,
    regtest: 0,
};

// Pre-built per-bound matchers. Anchored, uppercase-only, and without the /g flag
// so .test() carries no lastIndex state between calls.
const PRICE_PAIR_RE_LEGACY = new RegExp('^[A-Z]{3,' + PRICE_PAIR_TICKER_MAX_LEGACY + '}\\/[A-Z]{3,5}$');
const PRICE_PAIR_RE_WIDE   = new RegExp('^[A-Z]{3,' + PRICE_PAIR_TICKER_MAX_WIDE   + '}\\/[A-Z]{3,5}$');

// Whether the widened ticker bound is in effect for an action at `blockTime` on
// `network`.
//
// Fails CLOSED on anything it cannot evaluate: an unparseable time or an
// unrecognized network yields false, i.e. the legacy 5-character bound. Closed is
// the safe direction here because the legacy bound is what the deployed fleet
// already enforces, so a node that cannot evaluate the gate stays with the majority
// instead of unilaterally accepting a round nobody else will.
function isPricePairWideningActive(blockTime, network){
    // Reject the empty-ish values BEFORE Number(), which maps null, '' and false to
    // a perfectly finite 0. On a genesis-on network (threshold 0) that 0 reads as
    // ACTIVE, so a missing block time would silently widen the bound instead of
    // failing closed as this function promises.
    if(blockTime === null || blockTime === undefined || blockTime === '' || typeof blockTime === 'boolean')
        return false;
    let t = Number(blockTime);
    if(!Number.isFinite(t)) return false;
    let threshold = PRICE_PAIR_WIDEN_ACTIVATION[network];
    if(threshold === undefined) return false;
    return t >= threshold;
}

// The pair matcher in force for an action at `blockTime` on `network`.
function pricePairPattern(blockTime, network){
    return isPricePairWideningActive(blockTime, network) ? PRICE_PAIR_RE_WIDE : PRICE_PAIR_RE_LEGACY;
}

// Whether `pair` is a well-formed PRICE v0 pair name at `blockTime` on `network`.
// Non-string input is not well-formed (never coerced: String(null) would become
// the parseable-looking 'null' and String(['BTC/USD']) would silently pass).
function isValidPricePair(pair, blockTime, network){
    if(typeof pair !== 'string') return false;
    return pricePairPattern(blockTime, network).test(pair);
}

module.exports = {
    PRICE_PAIR_TICKER_MAX_LEGACY,
    PRICE_PAIR_TICKER_MAX_WIDE,
    PRICE_PAIR_WIDEN_ACTIVATION,
    PRICE_PAIR_RE_LEGACY,
    PRICE_PAIR_RE_WIDE,
    isPricePairWideningActive,
    pricePairPattern,
    isValidPricePair,
};
