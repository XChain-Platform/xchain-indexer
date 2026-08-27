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
 * PRICE v2 batching flag-day.
 *
 * A PRICE v2 action carries an hourly batch of full-body oracle rounds instead
 * of the single round a v0 action carries. Below this gate a PRICE|2 action is
 * invalid on every node, and records the same status a garbage VERSION field
 * already does ('invalid: VERSION (unknown)'), so existing-chain replay stays
 * byte-identical below the gate; at/above it, a well-formed v2 action is valid
 * on every node. A one-sided deploy forks the fleet on the first v2 round.
 *
 * CONSENSUS. This is a whole-action admissibility gate, not a shape change
 * inside an already-valid action: below the gate a leader that emits PRICE|2
 * signs bytes half the fleet will refuse to index at all.
 *
 * TIME-keyed, not height-keyed. A PRICE action is parsed by the indexer of
 * whichever chain carried it, and BTC/LTC/DOGE heights diverge, so no single
 * height names one cutover (same rationale price_pair_activation.js records,
 * and protocol_changes.js records for FIX_OUTPUT_FANOUT).
 *
 * LOCAL COPY of the canonical map in xchain-documentation/protocol/constants.js
 * (PRICE_BATCH_ACTIVATION); kept value-identical by
 * test/unit/activationConstantsParity.test.js. A one-sided edit forks PRICE v2
 * accept/reject at the flag-day.
 *
 ********************************************************************/

'use strict';

// Per-network activation TIME (LOCAL COPY of the canonical map in
// xchain-documentation/protocol/constants.js). Keyed on the action's own block time.
//
// UNARMED on mainnet: 9999999999 is a far-future sentinel (year 2286), NOT a
// scheduled flag-day. Arming is a separate operator pass (see the ledger),
// exactly as price_pair_activation.js's own mainnet entry is.
const PRICE_BATCH_ACTIVATION = {
    mainnet: 9999999999,  // UNARMED sentinel, see header for the operator-decision rationale
    testnet: 0,
    regtest: 0,
};

// Whether a PRICE v2 (batch) action is valid for an action at `blockTime` on
// `network`.
//
// Fails CLOSED on anything it cannot evaluate: an unparseable time or an
// unrecognized network yields false, i.e. v2 stays invalid. Closed is the safe
// direction here because no v2 action has ever been valid before this gate
// exists, so a node that cannot evaluate the gate stays with the majority
// instead of unilaterally accepting a batch nobody else will.
function isPriceBatchActive(blockTime, network){
    // Reject the empty-ish values BEFORE Number(), which maps null, '' and false to
    // a perfectly finite 0. On a genesis-on network (threshold 0) that 0 reads as
    // ACTIVE, so a missing block time would silently activate v2 instead of
    // failing closed as this function promises.
    if(blockTime === null || blockTime === undefined || blockTime === '' || typeof blockTime === 'boolean')
        return false;
    let t = Number(blockTime);
    if(!Number.isFinite(t)) return false;
    let threshold = PRICE_BATCH_ACTIVATION[network];
    if(threshold === undefined) return false;
    return t >= threshold;
}

module.exports = {
    PRICE_BATCH_ACTIVATION,
    isPriceBatchActive,
};
