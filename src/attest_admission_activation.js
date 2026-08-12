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
 * ATTEST v0 admission flag-day.
 *
 * At/above the activation height the indexer rejects an ATTEST v0 request
 * whose responsible set at the request's own block is smaller than its
 * REDUNDANCY. Such a request is unservable by construction: the v1 response
 * path requires >= REDUNDANCY valid signatures, and signatures can only come
 * from responsible-set members, so the threshold can never be reached. The
 * hub already refuses to start these unfinalizable rounds; before this gate
 * the request simply sat 'pending' until deadline expiry and refund. At/above
 * the gate it is rejected at admission instead, so the outcome is immediate
 * and no validator burns provider fetches on a dead request.
 *
 * The shrink this closes comes primarily from STAKE_WEIGHTED_QUORUM's
 * source-dedupe of the responsible-set selection (one slot per staking
 * source), which can leave fewer than REDUNDANCY distinct slots. Because
 * rejection changes on-chain acceptance, the gate is a consensus flag-day:
 * below the height the legacy accept-then-expire behavior is preserved
 * verbatim so replay stays bit-identical.
 *
 * ACTIVATION PLANE: LOCAL BLOCK HEIGHT, NOT a BTC anchor. This gate compares
 * the request's own block_index on its own chain against the threshold
 * below, and the threshold VALUE is a BTC-derived number, so the two are on
 * different planes for every chain except BTC. Concretely: 961000 is a BTC
 * height reached around 2026-08-04, but LTC and DOGE are already well past
 * that local height, so on those chains this rule is already active, while
 * only BTC actually flips at the anchor. This is deliberate-by-omission, not
 * a fork: every node computes the same predicate from the same local height,
 * so the fleet agrees and a from-genesis replay reproduces it exactly. It is
 * simply not the "all chains flip together" semantic that a snapshot_block
 * gate (like stake_weighted_quorum) would give. Do not swap in a BTC anchor
 * here without a flag-day of its own: that would change which LTC/DOGE
 * requests are admissible and break replay byte-identity on both chains.
 *
 * LOCAL COPY of the canonical map in xchain-documentation/protocol/
 * constants.js; kept value-identical by a parity test. A one-sided edit
 * forks ATTEST v0 accept/reject at the flag-day.
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
