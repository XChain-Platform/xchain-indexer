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
 * Gates when the validator anchor reward stops being trusted from the hub's
 * `pushvalidatorrewards` JSON-RPC and is instead derived by every indexer from
 * on-chain ANCHOR bytes. At/above this height the hub emits a publisher-bearing
 * ANCHOR bundle (v0 since the version restart, root-bearing by construction;
 * the retired v4/v5 pair is what split rootless from root-bearing) carrying
 * the elected publisher pubkey
 * plus a 2f+1 `oracle_publish` attestation (XANCPUB) over the reward tuple; the
 * indexer verifies that quorum and credits the publisher with
 * ANCHOR_REWARD_AMOUNT, a frozen consensus constant never taken from the wire.
 * Below the threshold the old push path stands and a publisher-bearing bundle
 * is rejected.
 *
 * The credited reward is a COLLECT-spendable `validator_rewards` row, so this
 * is consensus-relevant and must deploy to the hub and every indexer
 * atomically. It gates on the BTC-anchored `snapshot_block` carried by every
 * ANCHOR canonical, not a local processing height, so the hub and the
 * BTC/LTC/DOGE indexers all flip on the same anchor.
 *
 * A byte-identical twin of this module lives at the same path in the hub
 * (src/consensus/gates/anchor_reward_gate.js) and the map in
 * xchain-documentation/protocol/constants.js; a cross-service regression suite
 * keeps all copies byte-equal, since a divergence forks the derived reward row
 * and breaks federation/ledger parity.
 *
 ********************************************************************/

const { get, copy, activeAt } = require('../gate_registry');

const ANCHOR_REWARD_ACTIVATION = copy('anchor_reward_activation.ANCHOR_REWARD_ACTIVATION');

const ANCHOR_REWARD_AMOUNT = copy('anchor_reward_activation.ANCHOR_REWARD_AMOUNT');

// Whether anchor rewards are DERIVED from chain (vs pushed) for an ANCHOR whose
// BTC-anchored snapshot is at `snapshotBlock` on `network`. Below the threshold ->
// off (legacy push path; a publisher-bearing bundle rejected). Unknown network
// -> off (safe).
function isAnchorRewardActive(snapshotBlock, network){
    let sb = parseInt(snapshotBlock);
    if(!Number.isFinite(sb)) return false;
    let threshold = ANCHOR_REWARD_ACTIVATION[network];
    if(threshold === undefined) return false;
    return sb >= threshold;
}

const ARCHIVE_REWARD_ACTIVATION = copy('anchor_reward_activation.ARCHIVE_REWARD_ACTIVATION');

const ARCHIVE_REWARD_AMOUNT = copy('anchor_reward_activation.ARCHIVE_REWARD_AMOUNT');

// Whether the anchor_archive reward is DERIVED from chain (vs pushed) for an archive
// anchor whose BTC-anchored snapshot is at `snapshotBlock` on `network`. Below the
// threshold -> off (legacy push path; a publisher-bearing archive head rejected).
// Unknown network -> off (safe).
function isArchiveRewardActive(snapshotBlock, network){
    let sb = parseInt(snapshotBlock);
    if(!Number.isFinite(sb)) return false;
    let threshold = ARCHIVE_REWARD_ACTIVATION[network];
    if(threshold === undefined) return false;
    return sb >= threshold;
}

const ANCHOR_REWARD_DERIVE_ACTIVATION = copy('anchor_reward_activation.ANCHOR_REWARD_DERIVE_ACTIVATION');

// Whether anchor/archive reward derivation has RELOCATED to the BTC indexer for a reward tuple
// whose BTC-anchored snapshot is at `snapshotBlock` on `network`. Below the threshold (or an
// inert null / unknown network) -> off (legacy DOGE-side silent-drop path stays byte-identical).
function isAnchorRewardDeriveActive(snapshotBlock, network){
    let sb = parseInt(snapshotBlock);
    if(!Number.isFinite(sb)) return false;
    let threshold = ANCHOR_REWARD_DERIVE_ACTIVATION[network];
    if(threshold === null || threshold === undefined) return false;
    return sb >= threshold;
}

const ANCHOR_REWARD_MIRROR_MATURITY = copy('anchor_reward_activation.ANCHOR_REWARD_MIRROR_MATURITY');

const ANCHOR_REWARD_DOGE_MIN_CONFIRMATIONS = copy('anchor_reward_activation.ANCHOR_REWARD_DOGE_MIN_CONFIRMATIONS');

// The BTC block at which a mirrored attestation row whose XANCPUB signing set was resolved
// at `snapshotBlock` becomes derivable. Returns null for an unparseable height so callers
// fail closed rather than maturing everything at NaN.
function anchorRewardDeriveHeight(snapshotBlock){
    let sb = parseInt(snapshotBlock);
    if(!Number.isFinite(sb)) return null;
    return sb + ANCHOR_REWARD_MIRROR_MATURITY;
}

// The materialization block a RECOVERY-RESTORED anchor/archive reward claims, given the
// EARN block the ANCHOR archive carries for it. A restored row must claim the block it was
// FIRST derived at, never the height at which recovery happened to re-apply it: the
// live fleet minted the row at earnBlock + ANCHOR_REWARD_MIRROR_MATURITY (the fleet-agreed
// watermark above, identical on every node), so stamping that height is what makes a
// recovered node's validator_rewards set match a live node's at EVERY height - including
// under the reorg-scoping delete, which drops a reward whose creating block is orphaned.
// Returns null below the derive flag-day (or on an inert/unknown network), where no BTC-side
// row was ever minted by the derive path and the legacy NULL stamp must stay byte-identical.
function restoredRewardDeriveHeight(earnBlock, network){
    if(!isAnchorRewardDeriveActive(earnBlock, network)) return null;
    return anchorRewardDeriveHeight(earnBlock);
}

// The lowest EARN block whose restored reward can have been removed by a rollback to
// `reorgBlock`, i.e. the floor the recovery re-arm must sweep. A restored row is removed by
// EITHER scoping delete: block_index (earn) >= reorgBlock, or derive_block_index
// (= earn + maturity) >= reorgBlock, which is earn >= reorgBlock - maturity. Re-arming only
// the earn-block floor would leave a derive-scope-deleted row marked applied=1 forever, so
// the reward would be lost on this node while the live fleet re-derives it from its mirror.
// Clamped at the derive flag-day (rows below it carry no derive stamp and can only be taken
// by the earn-block delete) and at the reorg height (never re-arm MORE than the earn floor
// when derivation is inert on this network).
function restoredRewardRearmFloor(reorgBlock, network){
    let h = parseInt(reorgBlock);
    if(!Number.isFinite(h)) return null;
    let threshold = ANCHOR_REWARD_DERIVE_ACTIVATION[network];
    if(threshold === null || threshold === undefined) return h;
    return Math.max(0, Math.min(h, Math.max(h - ANCHOR_REWARD_MIRROR_MATURITY, Number(threshold))));
}

// ---------------------------------------------------------------------------
// The anchor-attest barrier's maturity horizon
// ---------------------------------------------------------------------------
//
// The anchor-attest member is the one place the mirror-barrier family's height rule is
// measurably WORSE than the clock it replaces, because the hub cannot advance that rail's
// height watermark past a snapshot whose deferred reward-attest entry is still queued and
// that queue's TTL is 6 h. So this member keeps its own maturity-horizon bound BESIDE the
// height rule rather than being superseded by it, and the min() at the call site is what
// guarantees the barrier can only ever open EARLIER than it does today, never later.
//
// The derive pass at block B reads exactly the rows with snapshot_block <= B -
// ANCHOR_REWARD_MIRROR_MATURITY. Every such row was written no later than
// time(snapshot_block) + the hub's arrival lag, so a watermark at or past
// horizonTime + ANCHOR_ATTEST_ARRIVAL_MARGIN_S certifies this node holds every row that
// pass will read, which is the completeness property in full.
//
// BYTE-IDENTICAL across xchain-{hub,indexer}/src/anchor_reward_activation.js and value-
// identical to xchain-documentation/protocol/constants.js, held by the activation-constants parity
// suite. Both values are hashed into the consensus-rules digest (SHARED_GATES), so a
// one-sided edit surfaces as a rules mismatch rather than as silent drift.

// The arming seam is SHARED with the mirror-admission family deliberately: one venue lever
// (XC_MIRROR_ADMISSION_ACTIVATION) arms both flag days, so a regtest drill cannot end up
// with the admission axis armed and the horizon axis inert and still be called a drill.
const { resolveMirrorAdmissionRegtest } = require('./mirror_admission_gate.js');

const ANCHOR_ATTEST_ARRIVAL_MARGIN_S = copy('anchor_reward_activation.ANCHOR_ATTEST_ARRIVAL_MARGIN_S');

const ANCHOR_ATTEST_BARRIER_ACTIVATION = get('anchor_reward_activation.ANCHOR_ATTEST_BARRIER_ACTIVATION');

/**
 * Whether the maturity-horizon barrier is ARMED for `network` at BTC height `height`.
 *
 * The Number.isFinite guard is on the THRESHOLD and it comes first, which is the whole
 * discipline: `0 >= null` is true in JavaScript, so a bare `height >= MAP[network]` would
 * arm every inert network at height 0 and open the barrier on a node that was never meant to
 * carry the new rule. An unknown network reads undefined here and is inert for the same
 * reason, and an unreadable height never arms a flag day.
 *
 * @param {string} network mainnet|testnet|regtest
 * @param {number|string} height the BTC height being evaluated
 * @returns {boolean}
 */
function isAnchorAttestBarrierHorizonActive(network, height){
    let threshold = ANCHOR_ATTEST_BARRIER_ACTIVATION[network];
    if(!Number.isFinite(threshold)) return false;
    let h = parseInt(height);
    if(!Number.isFinite(h)) return false;
    return h >= threshold;
}

module.exports = {
    ANCHOR_REWARD_ACTIVATION,
    ANCHOR_REWARD_AMOUNT,
    isAnchorRewardActive,
    ARCHIVE_REWARD_ACTIVATION,
    ARCHIVE_REWARD_AMOUNT,
    isArchiveRewardActive,
    ANCHOR_REWARD_DERIVE_ACTIVATION,
    isAnchorRewardDeriveActive,
    ANCHOR_REWARD_MIRROR_MATURITY,
    ANCHOR_REWARD_DOGE_MIN_CONFIRMATIONS,
    anchorRewardDeriveHeight,
    restoredRewardDeriveHeight,
    restoredRewardRearmFloor,
    ANCHOR_ATTEST_ARRIVAL_MARGIN_S,
    ANCHOR_ATTEST_BARRIER_ACTIVATION,
    isAnchorAttestBarrierHorizonActive
};
