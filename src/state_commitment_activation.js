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

// Per-chain activation height, interpreted as the processing chain's OWN
// block_index. At/after this height the new roots are committed; below it the
// state_tree_roots row is absent and the getblockhashes RPC returns null roots.
// ARMED MID-CHAIN like the stateHash.js class maps, which forces per-chain keys
// (one shared 'mainnet' height cannot fit BTC ~957k and DOGE ~6.28M at once).
// Lookup is '<COIN>:<network>' first, then the bare network key (regtest keeps
// one key; unknown -> inert/off, which is safe: roots simply stay absent).
// Same heights as the two state-hash gates armed 2026-07-07, so ONE deploy-by
// date governs all Cohort-C flips; each height precedes the Cohort-B BTC
// anchor (961000) as the checkpoint-commitment ordering requires.
const STATE_COMMITMENT_ACTIVATION = {
    'BTC:mainnet':  958500,     // ARMED 2026-07-07 at tip 957062; ~10 days of margin
    'LTC:mainnet':  3143000,    // ARMED 2026-07-07 at tip 3138154; ~8 days
    'DOGE:mainnet': 6291000,    // ARMED 2026-07-07 at tip 6280094; ~7.5 days
    'BTC:testnet':  145000,     // ARMED 2026-07-07 at tip 143299
    'LTC:testnet':  4805000,    // ARMED 2026-07-07 at tip 4797675
    'DOGE:testnet': 67000000,   // ARMED 2026-07-07 at tip 66498605 (fast chain, wide margin)
    regtest: 0,                 // armed from genesis: fresh regtest stacks exercise the roots end to end
};

// Resolve the per-chain threshold: '<COIN>:<network>' key first, then the bare
// network key. Production callers on mainnet/testnet MUST pass coin (all real
// call sites do: XChainIndexer block loop, sync ClientApplier/ServerPoller); a
// coin-less lookup on those networks finds no key and stays inert (off).
function _activationThreshold(network, coin){
    if(coin != null && STATE_COMMITMENT_ACTIVATION[coin + ':' + network] !== undefined)
        return STATE_COMMITMENT_ACTIVATION[coin + ':' + network];
    return STATE_COMMITMENT_ACTIVATION[network];
}

// Whether the light-client state commitment is in effect at `blockIndex` on
// `network` for `coin`. Below the threshold -> off (no roots written).
// Unknown network/coin -> off (safe).
function isStateCommitmentActive(blockIndex, network, coin){
    let b = parseInt(blockIndex);
    if(!Number.isFinite(b)) return false;
    let threshold = _activationThreshold(network, coin);
    if(threshold === undefined) return false;
    return b >= threshold;
}

// True only on the single activation boundary block (active here, inactive the
// block before). The indexer uses this to run the one-time full balances-tree
// initialization from pre-existing state before applying the boundary block.
function isStateCommitmentActivationBlock(blockIndex, network, coin){
    let b = parseInt(blockIndex);
    if(!Number.isFinite(b)) return false;
    return isStateCommitmentActive(b, network, coin) && !isStateCommitmentActive(b - 1, network, coin);
}

module.exports = {
    STATE_COMMITMENT_ACTIVATION,
    isStateCommitmentActive,
    isStateCommitmentActivationBlock
};
