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
 * PRICE v0 canonical price-value flag-day.
 *
 * A PRICE v0 round names each pair TICKER/FIAT and a price STRING. Every other
 * price entry point bounds that string's scale: the v1 push path caps the
 * decimal side at 8 places (PriceAggregator.receiveOraclePrice), the producer
 * normalizes with bcformat(price, 8) before its own bound
 * (XchainPriceSource._entry), and OracleConsensus._aggregate emits
 * bcformat(..., 8). The v0 wire alone accepts /^[0-9]+(\.[0-9]+)?$/, any number
 * of digits on either side of the point.
 *
 * So a quorum-signed v0 round carries values every other lane refuses, and two
 * of them bite.
 *
 * SCALE. 0.000000001 is refused by the v1 regex and by every producer, whose
 * bcformat(..., 8) renders it '0.00000000' and fails the positive lower bound.
 * It passes v0 ingest and finalizes into the unified store, which is the
 * one-lane-accepts-what-another-refuses case this seam exists to prevent.
 *
 * LENGTH. The accepted string is stored and mirrored verbatim into
 * price_snapshots.price, a VARCHAR(40) on the hub and on the indexer mirror. A
 * 42-character price clears every v0 gate, so under a permissive sql_mode the
 * stored row no longer equals the value the validators signed, and under
 * STRICT_TRANS_TABLES the INSERT throws and the whole round is refused as a
 * 'db error'. Which of the two happens is a database setting rather than a
 * protocol decision. OracleBatchSigner re-derives batch canonical bytes from
 * its own finalized price_snapshots rows and compares pair prices as strings,
 * so a truncated row also poisons later batch co-signing.
 *
 * THE RULE. At and above the threshold a v0 price is CANONICAL: no leading
 * zeros on the integer side, at most PRICE_SCALE_MAX_DECIMALS digits on the
 * decimal side, and a point only when digits follow it.
 *
 * The scale half and the leading-zero half are ONE rule because either alone
 * leaves the other consequence reachable. A scale cap by itself still admits
 * '00000000000000000000000001.5', arbitrarily long and 8-dp-legal, which
 * truncates exactly as the 42-character value does. Together they bound an
 * accepted price to 19 characters: PRICE_MAX is 10_000_000_000 and the ceiling
 * is exclusive, so at most 10 integer digits, a point, and 8 decimals. That is
 * what puts every accepted value inside VARCHAR(40) with room to spare and
 * makes the storage seam unreachable rather than merely wider, and it is why
 * no schema change carries this fix.
 *
 * It refuses nothing a producer emits. bcformat(..., 8) yields exactly this
 * form, so the honest wire is already canonical and arming changes no round the
 * federation assembles.
 *
 * CONSENSUS-AFFECTING, so gated: below the threshold a node accepts the loose
 * form and at/above it refuses, and a one-sided deploy forks the fleet on the
 * first round carrying either shape. Below the gate the legacy pattern is
 * preserved verbatim and a from-genesis replay stays byte-identical.
 *
 * TIME-keyed, not height-keyed, for the reason price_pair_activation records: a
 * PRICE v0 action is parsed by the indexer of whichever chain carried it, and
 * BTC/LTC/DOGE heights diverge, so no single height names one cutover.
 *
 * Resolved ONCE per action, alongside the pair-name bound, so every round in a
 * batch is judged under one rule and no window can straddle this gate.
 *
 * MAINNET IS UNARMED, on the house sentinel (9999999999, year 2286). Naming the
 * activation instant is a separate operator act and a one-line edit here.
 * testnet/regtest run from genesis, matching the price-pair family.
 *
 * VENDORED byte-identically into xchain-hub/src, where PriceAggregator gates
 * both v0 ingest paths on it. The hub resolves the same key the chain does, so
 * it can never sit stricter than consensus; a one-sided edit of either copy is
 * what would have it withhold a round the chain finalized. A test in each repo
 * pins the byte-equality.
 *
 ********************************************************************/

'use strict';

// Decimal-side bound in force at/above the gate. The producers' bcformat width.
const PRICE_SCALE_MAX_DECIMALS = 8;

// Per-network activation TIME, keyed on the action's own block time.
//
// UNARMED on mainnet: 9999999999 is a far-future sentinel (year 2286), not a
// scheduled flag-day. The instant this arms at is an open operator decision.
const PRICE_SCALE_ACTIVATION = {
    mainnet: 9999999999,  // UNARMED sentinel; the instant is the operator's to name
    testnet: 0,
    regtest: 0,
};

// The two price-value matchers. Anchored and without the /g flag so .test()
// carries no lastIndex state between calls.
//
// LEGACY is byte-for-byte the pattern both v0 ingest sites carry today; it is
// what keeps a below-gate replay identical, so it is never "tidied".
const PRICE_VALUE_RE_LEGACY = /^[0-9]+(\.[0-9]+)?$/;
const PRICE_VALUE_RE_CANONICAL =
    new RegExp('^(0|[1-9][0-9]*)(\\.[0-9]{1,' + PRICE_SCALE_MAX_DECIMALS + '})?$');

// Whether the canonical form binds for an action at `blockTime` on `network`.
//
// Fails CLOSED on anything it cannot evaluate: an unparseable time or an
// unrecognized network yields false, i.e. the legacy pattern. Closed is the safe
// direction because the legacy pattern is what the deployed fleet enforces, so a
// node that cannot evaluate the gate stays with the majority instead of
// unilaterally refusing a round everyone else accepts.
function isPriceScaleCanonicalActive(blockTime, network){
    // Reject the empty-ish values BEFORE Number(), which maps null, '' and false
    // to a perfectly finite 0. On a genesis-on network (threshold 0) that 0 reads
    // as ACTIVE, so a missing block time would silently tighten the bound instead
    // of failing closed as this function promises.
    if(blockTime === null || blockTime === undefined || blockTime === '' || typeof blockTime === 'boolean')
        return false;
    let t = Number(blockTime);
    if(!Number.isFinite(t)) return false;
    let threshold = PRICE_SCALE_ACTIVATION[network];
    if(threshold === undefined) return false;
    return t >= threshold;
}

// The price-value matcher in force for an action at `blockTime` on `network`.
function priceValuePattern(blockTime, network){
    return isPriceScaleCanonicalActive(blockTime, network)
        ? PRICE_VALUE_RE_CANONICAL : PRICE_VALUE_RE_LEGACY;
}

// Whether `price` is a well-formed PRICE v0 price value at `blockTime` on
// `network`. Non-string input is not well-formed and is never coerced: String(null)
// would become the parseable-looking 'null' and String(['1']) would silently pass.
function isValidPriceValue(price, blockTime, network){
    if(typeof price !== 'string') return false;
    return priceValuePattern(blockTime, network).test(price);
}

module.exports = {
    PRICE_SCALE_MAX_DECIMALS,
    PRICE_SCALE_ACTIVATION,
    PRICE_VALUE_RE_LEGACY,
    PRICE_VALUE_RE_CANONICAL,
    isPriceScaleCanonicalActive,
    priceValuePattern,
    isValidPriceValue,
};
