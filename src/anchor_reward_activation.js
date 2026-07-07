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
 * Anchor-reward re-derivation flag-day.
 *
 * Gates when the validator anchor reward stops being TRUSTED from the hub's
 * `pushvalidatorrewards` JSON-RPC and is instead DERIVED by every indexer from the
 * on-chain ANCHOR bytes. At/above this height the hub emits a publisher-bearing
 * ANCHOR (v4 rootless / v5 root-bearing) carrying the elected publisher pubkey plus
 * a 2f+1 `oracle_publish` attestation (XANCPUB) over the reward tuple; the indexer
 * verifies that quorum and credits the publisher with `ANCHOR_REWARD_AMOUNT` (the
 * amount is a frozen consensus constant, NEVER taken from the wire). Below the
 * threshold the old push path stands and v4/v5 anchors are rejected.
 *
 * Because the credited reward becomes part of the per-block ledger (a COLLECT-
 * spendable `validator_rewards` row), this is consensus-relevant and must deploy
 * hub + ALL indexers (+ the docs canonical) atomically on the same flag-day.
 *
 * Like checkpoint_commitment / stake_weighted_quorum / equivocation_header, this
 * gates on the BTC-anchored `snapshot_block` carried by every ANCHOR canonical (NOT
 * a local processing height), so the hub and the BTC/LTC/DOGE indexers all flip on
 * the same anchor. Per the note in protocol_changes.js, snapshot-block-gated rules
 * use this twin-module pattern, NOT protocol_changes.addChange.
 *
 * LOCAL COPY of the canonical map + amount in xchain-documentation/protocol/
 * constants.js, kept byte-equal by the cross-service regression suite (a divergence
 * forks the derived reward row and breaks federation/ledger parity). Byte-identical
 * twin lives in xchain-hub/src/anchor_reward_activation.js.
 *
 ********************************************************************/

// Per-network activation height, interpreted as the BTC-anchored snapshot_block
// carried by the ANCHOR canonical (NOT the local processing height), so every chain
// + the hub flip the reward-derivation path on the same anchor.
const ANCHOR_REWARD_ACTIVATION = {
    mainnet: 961000,      // ARMED 2026-07-07: BTC anchor ~2026-08-04; deploy hub + ALL indexers (+ sdk/explorer/sync copies) before this height
    testnet: 0,
    regtest: 0,
};

// The frozen validator anchor-publish reward. This is a CONSENSUS CONSTANT: the hub
// signs it into the XANCPUB attestation and the indexer re-derives it here, never
// from the wire. Changing it is itself a flag-day. Kept equal to the hub's historical
// default (ANCHOR_REWARD_PER_PUBLISH = '10.00000000').
const ANCHOR_REWARD_AMOUNT = '10.00000000';

// Whether anchor rewards are DERIVED from chain (vs pushed) for an ANCHOR whose
// BTC-anchored snapshot is at `snapshotBlock` on `network`. Below the threshold ->
// off (legacy push path; v4/v5 rejected). Unknown network -> off (safe).
function isAnchorRewardActive(snapshotBlock, network){
    let sb = parseInt(snapshotBlock);
    if(!Number.isFinite(sb)) return false;
    let threshold = ANCHOR_REWARD_ACTIVATION[network];
    if(threshold === undefined) return false;
    return sb >= threshold;
}

module.exports = {
    ANCHOR_REWARD_ACTIVATION,
    ANCHOR_REWARD_AMOUNT,
    isAnchorRewardActive
};
