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
 * Light-client checkpoint-commitment flag-day (SPV spec §6.1/§6.3, Phase 2).
 *
 * Gates when the quorum-signed checkpoint canonical (and the on-chain ANCHOR)
 * begin COMMITTING the additive `state_root` + `block_merkle_root` (with their
 * version bytes) that the Phase 1 STATE_COMMITMENT flag-day made the indexer
 * compute. At/above this height the checkpoint signing string gains
 * `|STATE_ROOT|STATE_ROOT_VERSION|BLOCK_MERKLE_ROOT|BLOCK_MERKLE_VERSION` and a
 * new ANCHOR v3 carries the roots on DOGE; below it both keep their old shape and
 * the roots are absent. Because it changes the SIGNED preimage of every checkpoint
 * signature it is consensus-relevant and must deploy hub + ALL indexers + the
 * SDK/explorer verifiers atomically.
 *
 * UNLIKE the Phase 1 state_commitment_activation (which gates on each chain's OWN
 * local block_index), this gates on the BTC-anchored `snapshot_block` carried by
 * every checkpoint canonical, exactly like stake_weighted_quorum / equivocation_
 * header, so the hub and the BTC/LTC/DOGE indexers all flip the SIGNED shape on the
 * same anchor.
 *
 * LOCAL COPY of the canonical map in xchain-documentation/protocol/constants.js,
 * kept byte-equal by the cross-service regression suite (a divergence forks the
 * signed checkpoint and breaks federation quorum verification). Byte-identical twins
 * live in xchain-{hub,sdk,explorer}/src/checkpoint_commitment_activation.js.
 *
 ********************************************************************/

// Per-network activation height, interpreted as the BTC-anchored snapshot_block
// carried by the checkpoint/ANCHOR canonical (NOT the local processing height), so
// every chain + the hub flip the signed shape on the same anchor.
const CHECKPOINT_COMMITMENT_ACTIVATION = {
    mainnet: 999999999,   // PLACEHOLDER: set the real BTC flag-day height before mainnet enable
    testnet: 0,
    regtest: 0,
};

// Whether the checkpoint/ANCHOR commits the light-client roots for a checkpoint
// whose BTC-anchored snapshot is at `snapshotBlock` on `network`. Below the
// threshold -> off (old canonical shape, no roots). Unknown network -> off (safe).
function isCheckpointCommitmentActive(snapshotBlock, network){
    let sb = parseInt(snapshotBlock);
    if(!Number.isFinite(sb)) return false;
    let threshold = CHECKPOINT_COMMITMENT_ACTIVATION[network];
    if(threshold === undefined) return false;
    return sb >= threshold;
}

module.exports = {
    CHECKPOINT_COMMITMENT_ACTIVATION,
    isCheckpointCommitmentActive
};
