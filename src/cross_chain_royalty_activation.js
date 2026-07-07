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
 * Cross-chain royalty match-canonical flag-day.
 *
 * Gates when the validator-signed XMATCH canonical carries the matched orders'
 * royalty payout legs (a_payout_legs / b_payout_legs). At/above this height the
 * four XMATCH builders (hub CrossChainDexEngine._canonicalMatch, hub
 * StateAnchorPublisher._matchCanonical, indexer cross_settle._canonical, indexer
 * recovery._matchCanonical) append the two legs fields to the signed bytes, so a
 * colluding hub cannot strip a royalty from a cross-chain match; below it the
 * canonical is byte-identical to the legacy format, so pre-existing signatures
 * keep verifying. The CREATE-side acceptance rule (deny a royalty-bearing
 * cross-chain listing while enforcement is impossible) is gated separately by
 * the CROSS_CHAIN_ROYALTY entry in the indexer's protocol_changes.js; the two
 * flag-days MUST be coordinated by the operator (canonical first or together,
 * never create-side first).
 *
 * Like checkpoint_commitment / stake_weighted_quorum / equivocation_header /
 * anchor_reward_activation, this gates on the BTC-anchored `snapshot_block`
 * carried by every match canonical (NOT a local processing height), so the hub
 * and the BTC/LTC/DOGE indexers all flip on the same anchor. Snapshot-block-
 * gated rules use this twin-module pattern, NOT protocol_changes.addChange
 * (see the note in protocol_changes.js).
 *
 * LOCAL COPY of the canonical map in xchain-documentation/protocol/constants.js,
 * kept byte-equal by the cross-service regression suite (a divergence forks the
 * signed match bytes and breaks federation parity). Byte-identical twin lives in:
 * xchain-indexer/src/cross_chain_royalty_activation.js
 * xchain-hub/src/cross_chain_royalty_activation.js
 *
 ********************************************************************/

// Per-network activation height, interpreted as the BTC-anchored snapshot_block
// carried by the XMATCH canonical (NOT the local processing height), so every
// chain + the hub flip the match format on the same anchor.
const CROSS_CHAIN_ROYALTY_ACTIVATION = {
    mainnet: 961000,      // ARMED 2026-07-07: BTC anchor ~2026-08-04; deploy hub + ALL indexers before this height
    testnet: 0,
    regtest: 0,
};

// Whether the XMATCH canonical carries the royalty payout legs for a match whose
// BTC-anchored snapshot is at `snapshotBlock` on `network`. Below the threshold ->
// off (legacy byte-identical canonical). Unknown network -> off (safe).
function isCrossChainRoyaltyActive(snapshotBlock, network){
    let sb = parseInt(snapshotBlock);
    if(!Number.isFinite(sb)) return false;
    let threshold = CROSS_CHAIN_ROYALTY_ACTIVATION[network];
    if(threshold === undefined) return false;
    return sb >= threshold;
}

module.exports = {
    CROSS_CHAIN_ROYALTY_ACTIVATION,
    isCrossChainRoyaltyActive
};
