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
 * XChain Platform: Capability-snapshot reorg buffer 
 *
 * A hub NEVER resolves a validator set at the height it was handed. Every
 * CapabilitySnapshot lookup subtracts CANONICAL_REORG_BUFFER first
 * (xchain-hub/src/CapabilitySnapshot.js `_buriedBlockIndex`), because stake state
 * at the tip is not reorg-safe: a shallow BTC reorg can rewrite the stake set of
 * the last few blocks, so a set locked AT the tip can serve a pre-reorg validator
 * set for up to the snapshot cache TTL.
 *
 * The wire, however, carries the RAW height. The checkpoint a hub signs declares
 * `snapshot_block: <raw>` (StateCheckpointEngine), the mirrored
 * `capability_snapshots` rows are written under the same raw block, and an
 * attestation request's `block_index` is likewise raw. That is deliberate: the
 * convention is that the wire names the height a caller asked about and EVERY
 * consumer buries it exactly once, locally.
 *
 * The defect this module closes is that the hub was the only party doing so. Three
 * verifier families outside xchain-hub re-derived the set from on-chain state at
 * the DECLARED height and therefore resolved a different set than the signer
 * whenever a validator's stake activated or deactivated inside the buried window
 * (H - CANONICAL_REORG_BUFFER, H]:
 *
 *   - xchain-indexer/src/actions/attest.js  (ATTEST v1 responsible-set + capability gate)
 *   - xchain-indexer/src/recovery.js        (archive `_verifyStakes` / `_verifyCompleteness`)
 *   - xchain-sdk/src/light.js               (SPV `followForward` signer-set proof)
 *
 * A deactivation inside that window made an honest archive unrecoverable
 * ("has no on-chain stake at block N (fabricated set?)"); an activation inside it
 * dropped a qualifying source; on the attestation path the same gap rejected
 * deterministic responses or stalled rounds. Proposal A (operator ruling,
 * 2026-08-11): teach every verifier to bury by this one shared constant and leave
 * the on-wire shape, and the hub-MIRRORED reads in xchain-indexer/src/db.js that
 * are self-consistent with the declared label, untouched.
 *
 * WHY THIS IS FLAG-DAY GATED. Burying changes ACCEPTANCE: bytes an un-upgraded
 * verifier rejects are accepted by an upgraded one and vice versa, so a partial
 * rollout FORKS acceptance instead of fixing it. It also changes how already
 * signed and anchored historical artifacts read. Both the coordinated activation
 * height and the disposition of pre-flag-day artifacts are operator decisions, so
 * mainnet and testnet ship INERT (null = never active) and only regtest, which has
 * no history to preserve, is on from genesis. Below the gate every consumer
 * behaves byte-for-byte as it did before this module existed.
 *
 * PLANE. The gate is keyed on the BTC-anchored declared snapshot_block, the same
 * plane (and the same call site) as `equivocation_header.isEquivHeaderActive`, NOT
 * on a local chain height. attest.js evaluates it against the request's own
 * block_index exactly as it already evaluates the EQUIV gate there; see
 * attest_admission_activation.js for why the two planes differ and why the
 * difference must not be "corrected" without its own flag-day.
 *
 * The canonical source of record is
 * xchain-documentation/protocol/reference-impl/snapshot_reorg_buffer.js; it is
 * vendored BYTE-IDENTICALLY into xchain-hub, xchain-indexer and xchain-sdk. The
 * cross-service conformance suite (ConsensusPrimitiveConformance.test.js) runs in
 * every one of those repos and asserts byte-identity of the local copy to this
 * source, so an unmirrored edit fails CI everywhere.
 *
 ********************************************************************/

'use strict';

// The reorg-depth buffer every party in a federation must resolve capability
// snapshots at. 6 = the BTC confirmation depth the platform already treats as
// buried (XCHAIN_CONFIRMATIONS_BTC). CONSENSUS-CRITICAL: the hub subtracts this
// before every snapshot lookup and refuses to boot on mainnet/testnet when a local
// override diverges (CapabilitySnapshot._resolveReorgBuffer), so a verifier that
// buries by a different depth resolves a different set than the signer.
const CANONICAL_REORG_BUFFER = 6;

// Per-network activation height (LOCAL COPY of the canonical map in
// xchain-documentation/protocol/constants.js, kept equal by the cross-service
// regression suite). Keyed on the BTC-anchored declared snapshot_block.
//
// INERT on mainnet/testnet (null = never active) until the operator ratifies a
// coordinated BTC snapshot_block: arming this changes acceptance itself, so a
// one-sided or partially-rolled-out arm forks the fleet rather than fixing it, and
// it also re-reads every checkpoint already signed and anchored under the current
// reading. Regtest is active from genesis (no history to preserve; the regtest
// suites exercise the buried resolution from block 0).
const SNAPSHOT_BURIAL_ACTIVATION = {
    mainnet: null,        // INERT placeholder: operator-ratify a BTC snapshot_block before arming 
    testnet: null,        // INERT placeholder: operator-ratify a BTC snapshot_block before arming 
    regtest: 0,
};

// Whether a verifier must bury the declared snapshot_block before re-deriving the
// validator set for it, on `network`.
//
// Fails CLOSED on anything it cannot evaluate (unparseable height, unknown or
// un-ratified network): closed means "resolve at the declared height", which is
// what the deployed fleet does today, so a node that cannot evaluate the gate
// stays with the majority instead of unilaterally resolving a set nobody else will.
function isSnapshotBurialActive(snapshotBlock, network){
    // Reject the empty-ish values BEFORE parseInt/Number, which map null, '' and
    // false to a perfectly finite 0. On a genesis-on network (threshold 0) that 0
    // reads as ACTIVE, so a missing height would silently bury instead of failing
    // closed as this function promises.
    if(snapshotBlock === null || snapshotBlock === undefined || snapshotBlock === '' || typeof snapshotBlock === 'boolean')
        return false;
    let sb = Number(snapshotBlock);
    if(!Number.isFinite(sb)) return false;
    let threshold = SNAPSHOT_BURIAL_ACTIVATION[network];
    if(threshold === null || threshold === undefined) return false;
    return sb >= threshold;
}

// The height a verifier must actually resolve the validator set at for a snapshot
// DECLARED at `snapshotBlock` on `network`: max(0, declared - CANONICAL_REORG_BUFFER)
// at/above the flag-day.
//
// Below the flag-day, or for any input the gate cannot evaluate, the declared value
// is returned VERBATIM (same reference, not coerced), so a pre-flag-day caller sees
// byte-identical behaviour to passing the declared height straight through, including
// the null/undefined/NaN sentinels each call site already handles its own way.
function buriedSnapshotBlock(snapshotBlock, network){
    if(!isSnapshotBurialActive(snapshotBlock, network)) return snapshotBlock;
    return Math.max(0, Math.floor(Number(snapshotBlock)) - CANONICAL_REORG_BUFFER);
}

module.exports = {
    CANONICAL_REORG_BUFFER,
    SNAPSHOT_BURIAL_ACTIVATION,
    isSnapshotBurialActive,
    buriedSnapshotBlock,
};
