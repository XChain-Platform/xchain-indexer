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
// PRE-ARMING BLOCKERS (ALL THREE LANDED 2026-08-13; the table stays inert until
// the operator picks the height). Three consensus defects sat on the derive path
// and were harmless only while this table was inert; arming mainnet or testnet
// before they landed would have forked the COLLECT rail. Their remedies are now
// in code and are described here because the remedies, not the defects, are what
// a ratifier has to verify deployed fleet-wide before picking a height.
//   (1) No mined-anchor proof: the hub wrote the attestation row on mempool
//       acceptance, not confirmation, and the mirrored schema carried no DOGE
//       txid, so a dropped or reorged anchor left its COLLECT-spendable reward
//       intact. CLOSED: the hub holds the row in _deferredRewardAttest until
//       _verifyAnchorOnChain binds that exact txid at that exact ANCHOR version
//       buried dogeConfirmations deep, the mirrored schema gained
//       doge_anchor_txid (idempotent forward migration in xchain-hub AND
//       xchain-indexer), and the BTC indexer re-proves mined depth itself
//       against the DOGE indexer's getanchorconfirmations federation read
//       before createValidatorReward.
//   (2) Non-deterministic materialization: attestations mirrored in with no
//       block-loop barrier, and derivation keyed on snapshot_block <=
//       blockIndex, unrelated to the mirror's arrival time. Two nodes whose
//       copies differed derived the same reward at different heights, forking
//       the ledger hash for identical BTC blocks. CLOSED by the operator's
//       2026-08-11 ruling (a): derivation is re-keyed onto the fleet-agreed
//       mirror-completeness watermark below (ANCHOR_REWARD_MIRROR_MATURITY),
//       and a node whose mirror is not provably caught up DEFERS the block
//       rather than deriving a partial set.
//   (3) The attestation row was never federated: it fanned out only to that
//       hub's own indexer subscribers, so each hub held a disjoint subset of
//       rows and an indexer derived only what its own hub happened to publish.
//       CLOSED: the confirmed write broadcasts the authenticated XANCREWARD
//       peer message, and every receiver re-verifies the XANCPUB quorum against
//       its OWN oracle_publish set at snapshot_block (and re-proves the anchor
//       mined) before writing its copy. The wire is transport, never trust.
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
//
// TESTNET IS ARMED AT 0 (operator ruling 2026-08-11, applied 2026-08-14). The
// deploy-first-then-flip window this table was held null for is a MAINNET
// concern: mainnet carries live COLLECT-spendable history, so flipping under a
// partially-upgraded fleet could fork the rail. Testnet was re-genesised with no
// pre-flag history, so there is no legacy set to diverge from and no mid-upgrade
// window to protect; what testnet has instead is the only chance to run the
// relocated derive path (hub attestation write, XANCREWARD federation, BTC-side
// re-verification, mirror-maturity deferral) on a real multi-host network before
// mainnet ratifies a height. Mainnet stays null until the operator picks one.
//
// TESTNET DEPLOY ORDER, unchanged by the arming: every testnet hub and indexer
// must carry BOTH schema migrations
// (2026-08-12-validator-rewards-derive-block-index.sql and
// 2026-08-13-anchor-reward-attestations-doge-anchor-txid.sql) before it processes
// an anchor, since a node on the old schema scopes the reorg delete on the
// earn-block alone and cannot bind the mined-anchor txid.
const ANCHOR_REWARD_DERIVE_ACTIVATION = {
    mainnet: null,        // INERT placeholder: the operator owns this height; the three blockers above have landed, ratification has not
    testnet: 0,           // ARMED at genesis 2026-08-14 per the 2026-08-11 operator ruling; see the testnet note above
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

// The fleet-agreed mirror-completeness watermark, in BTC blocks (operator ruling (a),
// 2026-08-11, settling AML #4172).
//
// Derivation used to mature a mirrored attestation the instant snapshot_block <= the BTC
// block being processed. snapshot_block is the height the XANCPUB signing set was resolved
// at, and it is ALREADY IN THE PAST when the row is written: the hub writes only after the
// DOGE anchor is buried dogeConfirmations deep, after a failover ladder that can hand the
// publish to a later hub, and after the XANCREWARD federation hop. The maturity key was
// therefore unrelated to the row's arrival, so two nodes whose mirrors differed by one row
// derived the same reward at different BTC heights and forked the ledger hash for identical
// blocks. A hub_db_sync barrier alone cannot fix that: snapshot_block is not a maturity key
// for a mirror whose arrival is governed by DOGE confirmation and hub failover.
//
// Re-keyed: a row matures at snapshot_block + ANCHOR_REWARD_MIRROR_MATURITY, a frozen
// constant every node applies identically, sized to exceed the worst-case arrival lag (60
// DOGE confirmations is ~1h, plus the anchor failover ladder, plus federation). The height
// is only half the barrier. The other half is fail-closed: a node whose attestation mirror
// is not provably caught up DEFERS the block (wait-then-retry, never a partial-set commit;
// see XChainIndexer._waitForAnchorAttestationMirror), so every node either derives the
// identical set at the identical height or does not advance at all. Changing this value
// moves the block a reward materializes at, so it is a hashed value: it is frozen with the
// activation map above and a change needs its own flag-day.
const ANCHOR_REWARD_MIRROR_MATURITY = 144;   // ~24h of BTC blocks

// The BTC block at which a mirrored attestation row whose XANCPUB signing set was resolved
// at `snapshotBlock` becomes derivable. Returns null for an unparseable height so callers
// fail closed rather than maturing everything at NaN.
function anchorRewardDeriveHeight(snapshotBlock){
    let sb = parseInt(snapshotBlock);
    if(!Number.isFinite(sb)) return null;
    return sb + ANCHOR_REWARD_MIRROR_MATURITY;
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
    anchorRewardDeriveHeight
};
