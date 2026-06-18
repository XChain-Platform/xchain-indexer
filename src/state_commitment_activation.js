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
 * Light-client state-commitment flag-day (SPV spec §6.4).
 *
 * Gates when the indexer begins computing + committing the additive per-block
 * `state_root` (balances+stakes SMT) and `block_merkle_root`. Additive: the three
 * consensus block hashes and BLOCK_HASH_VERSION are untouched; nodes simply start
 * writing the new roots at the activation height, exactly as `state_hash` v2 was
 * introduced.
 *
 * UNLIKE the settlement-signature flags (stake_weighted_quorum / equivocation_
 * header), which gate on the BTC-anchored `snapshot_block` so every chain + the
 * hub flip on one anchor, this gates on the chain's OWN local `block_index`: each
 * chain begins committing its own per-block root at its own height. The Phase 2
 * checkpoint/ANCHOR extension that SIGNS these roots is what gates on snapshot_block.
 *
 * LOCAL COPY of the canonical map in xchain-documentation/protocol/constants.js,
 * kept byte-equal by the cross-service regression suite (a divergence forks the
 * additive root and halts the xchain-sync follower). The byte-identical twin lives
 * in xchain-sync/src/state_commitment_activation.js.
 *
 ********************************************************************/

// Per-network activation height, interpreted as the processing chain's OWN
// block_index. At/after this height the new roots are committed; below it the
// state_tree_roots row is absent and the getblockhashes RPC returns null roots.
const STATE_COMMITMENT_ACTIVATION = {
    mainnet: 999999999,   // PLACEHOLDER: set the real per-chain flag-day height before mainnet enable
    testnet: 0,
    regtest: 0,
};

// Whether the light-client state commitment is in effect at `blockIndex` on
// `network`. Below the threshold -> off (no roots written). Unknown network -> off (safe).
function isStateCommitmentActive(blockIndex, network){
    let b = parseInt(blockIndex);
    if(!Number.isFinite(b)) return false;
    let threshold = STATE_COMMITMENT_ACTIVATION[network];
    if(threshold === undefined) return false;
    return b >= threshold;
}

// True only on the single activation boundary block (active here, inactive the
// block before). The indexer uses this to run the one-time full balances-tree
// initialization from pre-existing state before applying the boundary block.
function isStateCommitmentActivationBlock(blockIndex, network){
    let b = parseInt(blockIndex);
    if(!Number.isFinite(b)) return false;
    return isStateCommitmentActive(b, network) && !isStateCommitmentActive(b - 1, network);
}

module.exports = {
    STATE_COMMITMENT_ACTIVATION,
    isStateCommitmentActive,
    isStateCommitmentActivationBlock
};
