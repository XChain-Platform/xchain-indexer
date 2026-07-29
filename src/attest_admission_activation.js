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
 * ATTEST v0 admission flag-day (Pkg 7 / 87441a53 admission rejection).
 *
 * At/above the activation height the indexer REJECTS an ATTEST v0 request whose
 * responsible set at the request's own block is smaller than its REDUNDANCY.
 * Such a request is unservable by construction: the v1 response path requires
 * >= REDUNDANCY valid signatures, and signatures can only come from
 * responsible-set members, so signatures can never reach the threshold. The
 * hub already refuses to start these unfinalizable rounds
 * (xchain-hub AttestationConsensus.propose unfinalizable-round guard); before
 * this gate the request simply sat 'pending' until deadline expiry + refund.
 * At/above the gate it is rejected at admission instead, so the outcome is
 * immediate and no validator burns provider fetches on a dead request.
 *
 * The shrink this closes comes primarily from STAKE_WEIGHTED_QUORUM's
 * source-dedupe of the responsible-set selection (one slot per staking source),
 * which can leave fewer than REDUNDANCY distinct slots; a small qualifying
 * snapshot produces the same condition pre-dedupe. Because rejection changes
 * on-chain acceptance, the gate is a consensus flag-day: below the height the
 * legacy accept-then-expire behavior is preserved verbatim so replay stays
 * bit-identical.
 *
 * ── ACTIVATION PLANE: LOCAL BLOCK HEIGHT () ─────────────────
 *
 * This gate compares the request's OWN block_index on ITS OWN chain against
 * the threshold below. It is a LOCAL-HEIGHT gate, and the threshold value is
 * a BTC-derived number, so the two are on different planes for every chain
 * except BTC. Stating that plainly because the previous version of this
 * comment claimed the gate was keyed "exactly like stake_weighted_quorum.js",
 * which is NOT true and is what produced the finding: stake_weighted_quorum
 * gates on the BTC-anchored `snapshot_block` carried by each settlement, so
 * BTC, LTC, DOGE and the hub all flip on one BTC anchor. This gate does not.
 *
 * The consequence, spelled out so nobody has to rediscover it: 961000 is a BTC
 * height reached around 2026-08-04, but LTC and DOGE are at ~3.16M and ~6.3M
 * local height, so on those chains `block_index >= 961000` is ALREADY TRUE and
 * this rule is ALREADY ACTIVE. Only BTC actually flips at the anchor. ATTEST
 * requests do land on LTC and DOGE, so this is a live asymmetry, not a
 * hypothetical one.
 *
 * That asymmetry is deliberate-by-omission rather than harmful: every node
 * computes the same predicate from the same local height, so the fleet agrees
 * and a from-genesis replay reproduces it exactly. It is NOT a fork. It is
 * simply not the "all chains flip together" semantic the old comment promised,
 * and the  batch leaves the behavior alone (the gate is armed history)
 * while making the plane explicit. Do not "fix" this by swapping in a BTC
 * anchor without a flag-day of its own: that would change which LTC/DOGE
 * requests are admissible and break replay byte-identity on both chains.
 *
 * LOCAL COPY of the canonical map in
 * xchain-documentation/protocol/constants.js (ATTEST_ADMISSION_ACTIVATION);
 * kept value-identical by test/unit/activationConstantsParity.test.js. A
 * one-sided edit forks ATTEST v0 accept/reject at the flag-day.
 *
 ********************************************************************/

// Per-network activation height (LOCAL COPY of the canonical map in
// xchain-documentation/protocol/constants.js). Compared against the request's own
// LOCAL block_index on its own chain (see the ACTIVATION PLANE note above), which
// is the block the responsible set is computed at.
const ATTEST_ADMISSION_ACTIVATION = {
    // The VALUE is a BTC height; the COMPARISON is per-chain local. Numerically equal
    // to the STAKE_WEIGHTED_QUORUM anchor, but that gate resolves it on the
    // BTC-anchored snapshot_block plane, so the two do not flip together off BTC.
    mainnet: 961000,      // ARMED: BTC anchor ~2026-08-04; already satisfied on LTC/DOGE local heights; deploy ALL indexers before this height
    testnet: 0,
    regtest: 0,
};

// Whether the admission rejection is in effect for an ATTEST v0 request at
// `blockIndex` on `network`. Below the threshold -> legacy accept-then-expire.
// Unknown network -> off (safe: the legacy path is unchanged).
//
// `blockIndex` is the LOCAL height of the chain the request landed on, NOT a BTC
// anchor. Callers must pass the request's own BLOCK_INDEX (actions/attest.js does);
// passing a BTC-anchored height here would silently move the gate on LTC/DOGE.
function isAttestAdmissionActive(blockIndex, network){
    let b = parseInt(blockIndex);
    if(!Number.isFinite(b)) return false;
    let threshold = ATTEST_ADMISSION_ACTIVATION[network];
    if(threshold === undefined) return false;
    return b >= threshold;
}

module.exports = {
    ATTEST_ADMISSION_ACTIVATION,
    isAttestAdmissionActive
};
