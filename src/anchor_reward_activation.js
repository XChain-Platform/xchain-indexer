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
    mainnet: 961000,      // ARMED 2026-07-07: BTC anchor ~2026-08-04; deploy hub + ALL indexers before this height
    testnet: 0,
    regtest: 0,
};

// The frozen validator anchor-publish reward. This is a CONSENSUS CONSTANT: the hub
// signs it into the XANCPUB attestation and the indexer re-derives it, never from
// the wire. Changing it is itself a flag-day. Kept equal to the hub's historical
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

// Archive-reward re-derivation flag-day . Same shape as ANCHOR_REWARD_ACTIVATION,
// gating the ARCHIVE leg: at/above this BTC-anchored snapshot_block the elected archive
// leader emits a publisher-bearing archive anchor (v6 = the v1 archive anchor + the same
// PUBLISHER|ATTEST_SIG_COUNT|... tail as v4/v5, attested over an 'anchor_archive' XANCPUB
// canonical) and the indexer DERIVES the anchor_archive reward from those bytes; the
// key-authenticated pushvalidatorrewards rail is rejected for anchor_archive, closing the
// insider-with-key forge surface the per-chain flag-day left open. Below the threshold the
// legacy v1 + push path stands and v6 is rejected.
const ARCHIVE_REWARD_ACTIVATION = {
    mainnet: 969500,      // ARMED 2026-07-16 : BTC snapshot_block ~2026-10-01 (ratified anchor; derived from tip 957062 on 07-07 at ~144 blocks/day); deploy every consumer before this era
    testnet: 0,
    regtest: 0,
};

// The frozen archive-publish reward, signed into the archive XANCPUB attestation and
// re-derived by the indexer, never from the wire. Kept equal to the hub's historical
// default (ANCHOR_REWARD_PER_PUBLISH = '10.00000000'). Changing it is itself a flag-day.
const ARCHIVE_REWARD_AMOUNT = '10.00000000';

// Whether the anchor_archive reward is DERIVED from chain (vs pushed) for an archive
// anchor whose BTC-anchored snapshot is at `snapshotBlock` on `network`. Below the
// threshold -> off (legacy push path; v6 rejected). Unknown network -> off (safe).
function isArchiveRewardActive(snapshotBlock, network){
    let sb = parseInt(snapshotBlock);
    if(!Number.isFinite(sb)) return false;
    let threshold = ARCHIVE_REWARD_ACTIVATION[network];
    if(threshold === undefined) return false;
    return sb >= threshold;
}

// ─── ANCHOR_REWARD_DERIVE_ACTIVATION (, Option C derive-on-BTC-side) ────────────
// The flag-day that RELOCATES anchor-reward derivation from the DOGE indexer to the BTC
// indexer. ANCHOR is DOGE-only, but capability staking (hence the resolvable stake source
// createValidatorReward needs) is BTC-only, so the DOGE-side derivation gated by
// ANCHOR_REWARD_ACTIVATION / ARCHIVE_REWARD_ACTIVATION silently DROPS every publisher reward
// (no local stake -> _resolveActiveStakeSourceId returns null). At/above THIS gate:
//   - the DOGE indexer STOPS attempting the reward write (anchor.js skips createValidatorReward);
//   - the hub INSERTs one append-only `anchor_reward_attestations` row per attested reward tuple
//     after the XANCPUB quorum resolves, mirrored to every indexer via hub_db_sync;
//   - the BTC indexer DERIVES the reward from the mirrored row, re-verifying the XANCPUB sigs
//     against its OWN locally-computed oracle_publish/stake set at snapshot_block (mirror is
//     transport, not trust) and materializing validator_rewards at block_index = snapshot_block,
//     where the stake source actually resolves.
// Below the gate: byte-identical legacy behavior everywhere (DOGE-side write still attempted and
// silently dropped, no BTC-side derivation, no anchor_reward_attestations rows).
//
// This is CONSENSUS-relevant (validator_rewards is COLLECT-spendable) and must deploy hub + ALL
// indexers (+ the docs canonical) atomically on the same flag-day, so it gates on the same
// BTC-anchored snapshot_block height space as ANCHOR_REWARD_ACTIVATION (NOT a local processing
// height). It CANNOT ride the existing 961000/969500 boundaries: those are already 0 (live) on
// testnet/regtest, so riding them would flip the DOGE-skip + BTC-derive relocation the instant
// code deploys, with no coordinated deploy-first-then-flip window, risking a COLLECT-mediated
// fork across a mid-upgrade fleet; and one gate must cover BOTH the per-chain (v4/v5) and archive
// (v6) reward families uniformly. Per the  flag-day placeholder-guard doctrine, mainnet and
// testnet stay INERT (null = never active) until the operator ratifies a coordinated height;
// regtest activates from genesis so the fix is exercised where the bug lives.
const ANCHOR_REWARD_DERIVE_ACTIVATION = {
    mainnet: null,        // INERT placeholder: operator-ratify a BTC snapshot_block before arming
    testnet: null,        // INERT placeholder: operator-ratify a BTC snapshot_block before arming
    regtest: 0,
};

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

module.exports = {
    ANCHOR_REWARD_ACTIVATION,
    ANCHOR_REWARD_AMOUNT,
    isAnchorRewardActive,
    ARCHIVE_REWARD_ACTIVATION,
    ARCHIVE_REWARD_AMOUNT,
    isArchiveRewardActive,
    ANCHOR_REWARD_DERIVE_ACTIVATION,
    isAnchorRewardDeriveActive
};
