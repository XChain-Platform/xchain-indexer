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
 * Signed-retraction flag-day.
 *
 * Gates when hub reorg-retraction broadcasts (`row:deleted` events for the
 * quorum-class mirror tables cross_chain_calls / cross_chain_matches) stop
 * being TRUSTED from the key-authenticated push*reorg rail and must instead
 * carry a 2f+1 `cross_chain` validator co-signature set over the retraction
 * canonical (XRETRACTV1, produced by the hub's RetractionConsensus round;
 * each co-signer only signs a retraction its OWN chain indexer independently
 * pushed, the same trust tier as insertions of those tables). At/above the
 * threshold a mirror refuses an unsigned or under-signed quorum-class
 * retraction; below it the pre-existing generation-fence guards stand alone
 * and unsigned events remain accepted (legacy, rolling-deploy safe).
 *
 * Like anchor_reward / checkpoint_commitment / stake_weighted_quorum, this
 * gates on a BTC-anchored `snapshot_block` era, NOT a local processing
 * height. The signing hub stamps its resolved snapshot_block into the
 * canonical; a RECEIVING mirror decides whether the gate is in force from
 * its own mirrored capability_snapshots high-water mark (never from a wire
 * field an attacker could omit or understate).
 *
 * Byte-identical twins live in xchain-hub/src, xchain-indexer/src and
 * xchain-explorer/src (the explorer vendors the hub-mirror client). Keep
 * all three equal; the hub-mirror conformance suites compare the consumers.
 *
 ********************************************************************/

// Per-network activation, interpreted as a BTC-anchored snapshot_block era.
const RETRACTION_SIGNING_ACTIVATION = {
    mainnet: 963000,      // ARMED 2026-07-16, RE-PINNED 2026-08-12 off 969500 onto the shared pre-freeze train boundary (tip 959,853 on 07-27 at ~144 blocks/day + 21d); deploy every consumer before this era
    testnet: 0,
    regtest: 0,
};

// Whether quorum-class retraction broadcasts must be co-signed for an era at
// `snapshotBlock` on `network`. Below the threshold -> off (legacy unsigned
// events accepted under the pre-existing generation-fence guards). Unknown
// network -> off (safe for a rolling deploy; the indexer wires its network
// explicitly and tests pin it).
function isRetractionSigningActive(snapshotBlock, network){
    let sb = parseInt(snapshotBlock);
    if(!Number.isFinite(sb)) return false;
    let threshold = RETRACTION_SIGNING_ACTIVATION[network];
    if(threshold === undefined) return false;
    return sb >= threshold;
}

module.exports = {
    RETRACTION_SIGNING_ACTIVATION,
    isRetractionSigningActive
};
