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
 * PRICE price-RANGE flag day: the (0, PRICE_MAX) bound the hub already
 * enforces, brought onto the chain.
 *
 * THE GAP. Every hub ingest point bounds a price to strictly inside
 * (0, PRICE_MAX): PriceAggregator refuses a pair whose price is not
 * `parseFloat > 0` and `parseFloat < PRICE_MAX` on the single-round path, on the
 * batch path, and on the v1 oracle-price path, and constants.js states the
 * ceiling as the binding consensus bound that the ingestion layer MUST reject at
 * or above. The chain side checks only the decimal pattern. So a
 * quorum-signed round carrying '0', '0.00000000' or '10000000000.00000000' is
 * CHAIN-VALID and HUB-INVALID: the indexer stores it and pushes it, the hub
 * discards the whole round as 'invalid pairs', and nothing anywhere says so.
 *
 * WHY IT MATTERS MORE NOW. One signature set covers a whole batch window, so a
 * single out-of-range pair costs the federation the entire hour of prices the
 * batch carries rather than one round, and the loss is silent on both sides.
 * This is exactly the "hub stricter than the chain, an accepted window goes
 * missing without a word" shape the batching spec was written to avoid. The
 * defect predates batching and applies identically to both v0 wire forms.
 *
 * THE RULE. At and above the flag day a price is valid only when
 * `parseFloat(String(price)) > 0` and `parseFloat(String(price)) < PRICE_MAX`,
 * evaluated with the SAME expression the hub evaluates.
 *
 * THE FLOAT SEMANTICS ARE THE POINT, NOT A WART. Exact bcmath comparators would
 * be the better bound in isolation, and they are what the FEE check uses, but
 * here agreement with the hub IS the requirement, and the hub compares doubles.
 * The two differ on real wire values: '9999999999.99999999' is the widest string
 * the scale rule admits, yet parseFloat rounds it to exactly 10000000000 (the ulp
 * below 1e10 is 1.907e-6, so every value within about 9.5e-7 of the ceiling
 * rounds onto it, far wider than the 1e-8 gap), so the hub refuses it.
 * A chain using exact math would ACCEPT that value and hand the hub a round it
 * throws away, which is the defect again with a smaller footprint. Matching the
 * hub's expression is what closes it. If the pair of them should later move to
 * exact math, both sides move in one coordinated flag day, and the chain never
 * moves first.
 *
 * DIRECTION OF SAFETY. At and above the gate the chain bound equals the hub
 * bound; below it the chain is LOOSER. So the chain never refuses a round the
 * hub would have finalized, in either posture: the gate can only converge the
 * two upward, never invert them.
 *
 * CONSENSUS-AFFECTING, so gated: below the flag day a node accepts an
 * out-of-range price and at/above it refuses, and a one-sided deploy forks the
 * fleet on the first round carrying one. Below the gate the legacy behaviour is
 * preserved exactly (no range test at all runs), so a from-genesis replay is
 * byte-identical.
 *
 * TIME-keyed, not height-keyed, for the reason price_pair_activation records: a
 * PRICE action is parsed by the indexer of whichever chain carried it, and
 * BTC/LTC/DOGE heights diverge, so no single height names one cutover. Resolved
 * ONCE per action, alongside the pair-name and price-scale bounds, so every round
 * in a batch is judged under one rule and no window can straddle this gate.
 *
 * SIZING. MAINNET IS null, the inert sentinel: the legacy path runs byte for
 * byte and the operator owns that instant, which rides the same coordinated
 * train as the rest of the oracle cohort. Testnet carries live public ledgers,
 * so it is armed at a future instant with deploy headroom rather than at
 * genesis: unlike the price-scale and pair-name bounds, an out-of-range price is
 * expressible in the CANONICAL form ('0.00000000' is scale-legal), so a
 * genesis arming there would re-grade any such round already in testnet history
 * instead of only tightening a shape nothing ever emitted. Regtest is 0 so the
 * e2e oracle venue exercises the armed rule from genesis.
 *
 * It refuses nothing an honest producer emits. XchainPriceSource bounds every
 * value it publishes to (0, PRICE_MAX) before it leaves that file,
 * OracleConsensus refuses to co-sign outside the same band, and OracleBatchSigner
 * re-derives batch bytes from finalized price_snapshots rows, which the hub only
 * ever admitted in range. So arming changes no window the federation assembles.
 *
 * NOT VENDORED. The hub needs no twin of this file: its bound is unconditional
 * and already strict, and gating the hub on this key would only LOOSEN it, which
 * is the wrong direction for a store of record. The chain converges to the hub
 * here, not the other way round.
 *
 ********************************************************************/

'use strict';

// The consensus ceiling, read from this repo's copy of the protocol constants so
// the chain bound and the value the cross-repo equality gate watches cannot
// drift apart. Exclusive: a price AT the ceiling is refused.
const { PRICE_MAX } = require('./protocol/constants.js');

// Per-network activation TIME, keyed on the action's own block time.
const PRICE_ZERO_VALIDITY_ACTIVATION = {
    mainnet: null,          // INERT: operator-owned instant, unratified. The legacy path runs byte for byte.
    testnet: 1790812800,    // SIZED 2026-09-11: 2026-10-01 00:00:00 UTC, about three weeks of deploy headroom on a live public ledger; keyed on the action's block time
    regtest: 0,             // ARMED at genesis so the e2e oracle venue exercises the armed rule
};

// Whether the range bound binds for an action at `blockTime` on `network`.
//
// Fails CLOSED on anything it cannot evaluate: an unparseable time, an inert
// network (null) or an unrecognized one yields false, i.e. no range test, which
// is what the deployed fleet enforces today. Closed is the safe direction
// because a node that cannot evaluate the gate then stays with the majority
// instead of unilaterally refusing a round everyone else accepts.
//
// `null` is the INERT sentinel and must read as "off": without the isFinite
// guard `t >= null` coerces to `t >= 0` and would arm the rule on every block of
// an unratified network, the inverse of what the sentinel means.
function isPriceZeroValidityActive(blockTime, network){
    let threshold = PRICE_ZERO_VALIDITY_ACTIVATION[network];
    if(!Number.isFinite(threshold)) return false;
    // Reject the empty-ish values BEFORE Number(), which maps null, '' and false
    // to a perfectly finite 0. On a genesis-armed network (threshold 0) that 0
    // reads as ACTIVE, so a missing block time would silently tighten the bound
    // instead of failing closed as this function promises.
    if(blockTime === null || blockTime === undefined || blockTime === '' || typeof blockTime === 'boolean')
        return false;
    let t = Number(blockTime);
    if(!Number.isFinite(t)) return false;
    return t >= threshold;
}

// The hub's own admission predicate, ungated: strictly inside (0, PRICE_MAX)
// under IEEE-754 double comparison.
//
// Written as two negated comparisons rather than `p > 0 && p < PRICE_MAX`
// because that is the form PriceAggregator carries at all three of its ingest
// points, and NaN must fall on the refusing side at both ends: an unparseable
// value makes every comparison false, so the negations reject it while the
// positive form would too but only by accident of operator ordering. Keeping the
// expression identical is what lets a reader diff the two files and see one rule.
function isPriceInHubRange(price){
    let p = parseFloat(String(price));
    return !(!(p > 0) || !(p < PRICE_MAX));
}

// Whether `price` is admissible for an action at `blockTime` on `network`.
// Below the flag day everything the legacy pattern admitted stays admissible,
// which is what keeps a from-genesis replay byte-identical.
function isPriceRangeValid(price, blockTime, network){
    if(!isPriceZeroValidityActive(blockTime, network)) return true;
    return isPriceInHubRange(price);
}

module.exports = {
    PRICE_MAX,
    PRICE_ZERO_VALIDITY_ACTIVATION,
    isPriceZeroValidityActive,
    isPriceInHubRange,
    isPriceRangeValid,
};
