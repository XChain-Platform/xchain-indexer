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
 * ANCHOR (v4 rootless / v5 root-bearing) carrying the elected publisher pubkey
 * plus a 2f+1 `oracle_publish` attestation (XANCPUB) over the reward tuple; the
 * indexer verifies that quorum and credits the publisher with
 * ANCHOR_REWARD_AMOUNT, a frozen consensus constant never taken from the wire.
 * Below the threshold the old push path stands and v4/v5 anchors are rejected.
 *
 * The credited reward is a COLLECT-spendable `validator_rewards` row, so this
 * is consensus-relevant and must deploy to the hub and every indexer
 * atomically. It gates on the BTC-anchored `snapshot_block` carried by every
 * ANCHOR canonical, not a local processing height, so the hub and the
 * BTC/LTC/DOGE indexers all flip on the same anchor.
 *
 * A byte-identical twin of the map and amount lives in
 * xchain-hub/src/anchor_reward_activation.js and in
 * xchain-documentation/protocol/constants.js; a cross-service regression suite
 * keeps all copies byte-equal, since a divergence forks the derived reward row
 * and breaks federation/ledger parity.
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

// Archive-reward re-derivation flag-day. Same shape as ANCHOR_REWARD_ACTIVATION,
// gating the ARCHIVE leg: at/above this BTC-anchored snapshot_block the elected
// archive leader emits a publisher-bearing archive anchor (v6, the v1 archive
// anchor plus the same PUBLISHER|ATTEST_SIG_COUNT|... tail as v4/v5, attested
// over an 'anchor_archive' XANCPUB canonical) and the indexer derives the
// anchor_archive reward from those bytes; the key-authenticated
// pushvalidatorrewards rail is rejected for anchor_archive, closing the
// insider-with-key forge surface the per-chain flag-day left open. Below the
// threshold the legacy v1 + push path stands and v6 is rejected.
const ARCHIVE_REWARD_ACTIVATION = {
    mainnet: 963000,      // ARMED 2026-07-16, RE-PINNED 2026-08-12 off block 969500 onto the mainnet pre-freeze deploy-train boundary (tip 959,853 on 07-27 at ~144 blocks/day + 21d); deploy every consumer before this height
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

// ANCHOR_REWARD_DERIVE_ACTIVATION (Option C: derive on the BTC side).
// Relocates anchor-reward derivation from the DOGE indexer to the BTC indexer.
// ANCHOR is DOGE-only, but capability staking (the stake source
// createValidatorReward needs) is BTC-only, so DOGE-side derivation silently
// drops every publisher reward (no local stake -> _resolveActiveStakeSourceId
// returns null). At/above this gate: the DOGE indexer stops attempting the
// reward write; the hub inserts one append-only `anchor_reward_attestations`
// row per attested reward tuple after the XANCPUB quorum resolves, mirrored to
// every indexer; and the BTC indexer derives the reward from the mirrored row,
// re-verifying the XANCPUB signatures against its own locally-computed
// oracle_publish/stake set at snapshot_block (the mirror is transport, not
// trust) before materializing validator_rewards there. Below the gate,
// behavior is byte-identical to legacy (DOGE-side write still attempted and
// silently dropped, no BTC-side derivation).
//
// Consensus-relevant (validator_rewards is COLLECT-spendable): must deploy hub
// + all indexers atomically, on the same BTC-anchored snapshot_block space as
// ANCHOR_REWARD_ACTIVATION. It cannot ride the existing 961000/963000
// boundaries because those are already live (0) on testnet/regtest, which
// would flip this relocation the instant code deploys with no coordinated
// deploy-first-then-flip window, risking a COLLECT-mediated fork mid-upgrade.
// An unratified flag-day stays inert (null) until the operator picks a
// coordinated height; regtest activates from genesis so the fix is exercised
// where the bug lives.
//
// PRE-ARMING BLOCKERS: three consensus defects sit on the derive path and are
// harmless only while this table is inert. Arming mainnet or testnet before
// they land forks the COLLECT rail.
//   (1) No mined-anchor proof: the hub writes the attestation row on mempool
//       acceptance, not confirmation, and the mirrored schema carries no DOGE
//       txid or confirmation depth, so a dropped or reorged anchor leaves its
//       COLLECT-spendable reward intact. Needs a hub-side fix plus a mirrored
//       schema column.
//   (2) Non-deterministic materialization: attestations mirror in with no
//       block-loop barrier, and derivation keys on snapshot_block <=
//       blockIndex, unrelated to the mirror's arrival time. Two nodes whose
//       copies differ derive the same reward at different heights, forking
//       the ledger hash for identical BTC blocks.
//   (3) The attestation row is never federated: it fans out only to that
//       hub's own indexer subscribers, so each hub holds a disjoint subset of
//       rows and an indexer derives only what its own hub happened to
//       publish. Needs a new authenticated peer message whose receiver
//       re-verifies the XANCPUB quorum itself, landing after (1) so the
//       broadcast sits at the confirmed write.
//
// PRE-ARMING DEPLOY STEP (already fixed in code): a derived reward earns at
// the checkpoint's snapshot_block but materializes at a later BTC block, and
// the reorg delete used to scope only on the earn-block, leaving a
// COLLECT-spendable reward a from-genesis replay had not derived yet.
// validator_rewards now also carries derive_block_index, and rollback deletes
// on both keys. This is a schema change on a table xchain-sync replicates to
// validators: apply the matching migration
// (src/sql/migrations/2026-08-12-validator-rewards-derive-block-index.sql)
// fleet-wide before ratifying a mainnet/testnet height, or a lagging node
// keeps the old earn-block-only scoping and forks the COLLECT rail after a
// reorg.
const ANCHOR_REWARD_DERIVE_ACTIVATION = {
    mainnet: null,        // INERT placeholder: ratify a BTC snapshot_block only after all three pre-arming blockers above land
    testnet: null,        // INERT placeholder: ratify a BTC snapshot_block only after all three pre-arming blockers above land
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
