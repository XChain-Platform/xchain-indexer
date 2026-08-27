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
 * `price` capability resolution from the hub-mirrored snapshot, off BTC.
 *
 * Capability staking is BTC-only at the protocol level (coins/DOGE.js and
 * coins/LTC.js both declare CAPABILITIES: {}), so a non-BTC indexer has no local
 * `stakes` rows to resolve a capability from. The hub-mirrored
 * `capability_snapshots` table exists exactly so it can resolve one anyway, and
 * db.js redirects to it for `cross_chain` (match settlement) and `oracle_publish`
 * (the DOGE-only ANCHOR action). `price` was never in that scope, so on the only
 * chain PRICE is actually published to it resolves an EMPTY validator set: the
 * stake-weighted quorum then sums to zero and every PRICE action on that chain
 * records 'invalid: insufficient signer stake' with signatures that all verify.
 * At/above this gate `price` joins the redirect and those actions are valid.
 *
 * CONSENSUS, and in the direction that makes gating mandatory. This flips already
 * chained bytes from invalid to valid: a PRICE action that a deployed node
 * recorded invalid becomes valid on an upgraded one, so an ungated change makes a
 * from-genesis reindex diverge from the chain the fleet already agreed on, and a
 * mixed-version fleet forks on the first PRICE action. Below the gate resolution
 * stays on the local-stakes path VERBATIM, so existing-chain replay is untouched.
 *
 * TIME-keyed, not height-keyed. A PRICE action is parsed by the indexer of
 * whichever chain carried it, and BTC/LTC/DOGE heights diverge, so no single
 * height names one cutover (same rationale price_pair_activation.js and
 * price_batch_activation.js record, and protocol_changes.js records for
 * FIX_OUTPUT_FANOUT). The key is the PRICE action's own block time on its landing
 * chain, which every node parsing that chain reads identically.
 *
 * BOTH resolvers or neither. db.js routes the count resolver
 * (getValidatorsByCapability) and the weight resolver (getStakeWeightsByCapability)
 * through ONE predicate that consults this gate. Flipping only one of them would
 * have a node tally signatures against one validator set and divide by a quorum
 * denominator computed from another, producing a verdict no other node reaches.
 *
 * UNARMED on mainnet: 9999999999 is a far-future sentinel (year 2286), NOT a
 * scheduled flag-day. Arming is an operator decision that needs a CENSUS of the
 * existing mainnet PRICE actions first, because every one of them that landed off
 * BTC and recorded 'invalid: insufficient signer stake' flips to valid at the
 * instant this arms, and each flip also admits an oracle_round reward split that
 * the invalid status suppressed today (actions/price.js gates the derivation on
 * !error). The census decides whether an arming height is a clean cutover or a
 * rewrite of settled ledger state.
 *
 * LOCAL COPY of the canonical map in xchain-documentation/protocol/constants.js
 * (PRICE_CAPABILITY_SNAPSHOT_ACTIVATION); kept value-identical by
 * test/unit/activationConstantsParity.test.js. A one-sided edit forks PRICE
 * validity at the flag-day.
 *
 ********************************************************************/

'use strict';

// Per-network activation TIME (LOCAL COPY of the canonical map in
// xchain-documentation/protocol/constants.js). Keyed on the action's own block time.
//
// UNARMED on mainnet: 9999999999 is a far-future sentinel (year 2286), NOT a
// scheduled flag-day. See the header for the census the arming pass depends on.
const PRICE_CAPABILITY_SNAPSHOT_ACTIVATION = {
    mainnet: 9999999999,  // UNARMED sentinel, see header for the operator-decision rationale
    testnet: 0,
    regtest: 0,
};

// Whether a non-BTC indexer resolves the `price` capability from the hub-mirrored
// capability_snapshots for an action at `blockTime` on `network`.
//
// Fails CLOSED on anything it cannot evaluate: an unparseable time or an
// unrecognized network yields false, i.e. the local-stakes path the deployed fleet
// already uses. Closed is the safe direction here because that path is what every
// node agrees on today, so a node that cannot evaluate the gate stays with the
// majority instead of unilaterally validating rounds nobody else will.
function isPriceCapabilitySnapshotActive(blockTime, network){
    // Reject the empty-ish values BEFORE Number(), which maps null, '' and false to
    // a perfectly finite 0. On a genesis-on network (threshold 0) that 0 reads as
    // ACTIVE, so a missing block time would silently switch the resolution source
    // instead of failing closed as this function promises.
    if(blockTime === null || blockTime === undefined || blockTime === '' || typeof blockTime === 'boolean')
        return false;
    let t = Number(blockTime);
    if(!Number.isFinite(t)) return false;
    let threshold = PRICE_CAPABILITY_SNAPSHOT_ACTIVATION[network];
    if(threshold === undefined) return false;
    return t >= threshold;
}

module.exports = {
    PRICE_CAPABILITY_SNAPSHOT_ACTIVATION,
    isPriceCapabilitySnapshotActive,
};
