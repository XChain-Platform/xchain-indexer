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
 * DISPENSER fresh-address ORACLE SHAPE flag-day (incident: dispenser
 * freshness oracle, fail-open shape).
 *
 * Below the dispenser-freshness causality flag-day
 * (dispenser_freshness_activation.js) the fresh-address verdict is still derived
 * from the external utxo-tracker's get_first_seen answer. UtxoTracker.getFirstSeen
 * maps a NON-NULL answer whose `height` is not a number ('750000', true, a nested
 * object, a missing field, a non-object result) to null, and dispenser.js reads
 * null as "this address has never appeared on chain" and GRANTS the fresh-address
 * exception against DISPENSER_PREFERENCE. A malformed-but-successful tracker reply
 * therefore FAILS OPEN into a consensus-relevant verdict: the create is accepted
 * and lands in hashed history, and a peer whose tracker answered the same address
 * correctly rejects it, forking the ledger hash. The three other malformed-answer
 * surfaces (transport failure, HTTP non-200, an RPC error field) already throw, and
 * the caller's catch turns a throw into isFresh=false, i.e. fail CLOSED. A
 * shape-violating result is the one hole left in that wall.
 *
 * At/after this gate a non-null get_first_seen result without a numeric `height`
 * THROWS instead of reading as "never seen", so it joins the other malformed-answer
 * surfaces and the verdict fails closed. Below the gate the legacy null is returned
 * byte for byte, so replay of every DISPENSER already in hashed history is
 * unchanged.
 *
 * Scoped to the shape violation ALONE. A numeric height that is out of range
 * (negative, fractional, NaN, Infinity) is deliberately left passing the guard:
 * those already fail closed, because `firstSeen.height >= BLOCK_INDEX` is false for
 * NaN and the caller then reads the address as not fresh. Widening the guard into a
 * range check would move verdicts that are not fail-open, which is a separate
 * consensus change and would need its own flag day.
 *
 * Gate semantics mirror the sibling causality-gate modules in this repo: keyed on
 * the processing chain's OWN local block_index, '<COIN>:<network>' lookup first,
 * then the bare network key; null is the UNRATIFIED sentinel and unknown is
 * inert, both reading as off (the legacy fail-open null, which is deployed
 * behavior).
 *
 * Execution-path gate (an acceptance decision during action processing), NOT a
 * hashing-path change: xchain-sync's BlockHasher reads the already-materialized
 * action rows and never re-runs dispenser validation, so this gate is indexer-only
 * and has no xchain-sync twin. It is also the second gate on the same verdict, and
 * the two compose in one direction only: at/after the freshness causality gate the
 * tracker is never consulted at all, so this gate can only ever bite in the window
 * BELOW that one.
 *
 * MAINNET IS UNARMED (null): the window this gate governs there is the span below
 * the ratified per-coin freshness heights (BTC 961000, LTC 3154250, DOGE 6319000),
 * so its height is operator-owned and must be sized on the same train that arms
 * it, strictly below the coin's freshness height (above it the gate is dead code)
 * and above the fleet's deploy tip (a height already passed is not a flag day: a
 * node replaying from genesis would apply the rule where a long-running node never
 * did, and the two diverge at the first hash comparison). Testnet and regtest are
 * genesis-active, which changes nothing that ever ran there: both are
 * genesis-active on the freshness causality gate too, so the tracker path is
 * unreachable on those networks and no verdict in either ledger was computed from
 * a tracker answer. Arming them from genesis is what keeps the strict path
 * exercised end to end rather than dark until the mainnet flag day.
 *
 ********************************************************************/

'use strict';

// Per-chain activation height, interpreted as the processing chain's OWN
// block_index. At/after the height a shape-violating non-null get_first_seen
// result throws; below it the legacy fail-open null is returned.
const DISPENSER_FRESHNESS_SHAPE_ACTIVATION = {
    'BTC:mainnet':  null,   // UNARMED: operator-owned, sized below 961000 on the arming train
    'LTC:mainnet':  null,   // UNARMED: operator-owned, sized below 3154250 on the arming train
    'DOGE:mainnet': null,   // UNARMED: operator-owned, sized below 6319000 on the arming train
    mainnet:        null,   // UNARMED: a coin with no entry above inherits the inert posture
    testnet:        0,      // genesis-active: the tracker path is unreachable there, nothing replays differently
    regtest:        0,      // genesis-active so the venue exercises the strict path
};

// Resolve the per-chain threshold: '<COIN>:<network>' key first, then the bare
// network key. Unknown network -> undefined -> inert/off.
function _activationThreshold(network, coin){
    if(coin != null && DISPENSER_FRESHNESS_SHAPE_ACTIVATION[coin + ':' + network] !== undefined)
        return DISPENSER_FRESHNESS_SHAPE_ACTIVATION[coin + ':' + network];
    return DISPENSER_FRESHNESS_SHAPE_ACTIVATION[network];
}

// Whether a shape-violating get_first_seen answer is a hard failure at
// `blockIndex` on `network` for `coin`, rather than the legacy "never seen" null.
//
// null is the UNRATIFIED sentinel and must read as off: without the explicit null
// test `b >= null` coerces to `b >= 0` and arms the flip on every block of an
// unratified chain, the inverse of what the sentinel means.
function isDispenserFreshnessShapeStrict(blockIndex, network, coin){
    let threshold = _activationThreshold(network, coin);
    if(threshold === null || threshold === undefined) return false;
    let b = parseInt(blockIndex);
    if(!Number.isFinite(b)) return false;
    return b >= threshold;
}

module.exports = {
    DISPENSER_FRESHNESS_SHAPE_ACTIVATION,
    isDispenserFreshnessShapeStrict
};
