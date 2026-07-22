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
 * bit-identical. Keyed on the request's own block_index + network exactly like
 * stake_weighted_quorum.js, and armed to the SAME mainnet anchor (961000) so
 * both rules flip together.
 *
 * LOCAL COPY of the canonical map in
 * xchain-documentation/protocol/constants.js (ATTEST_ADMISSION_ACTIVATION);
 * kept value-identical by test/unit/activationConstantsParity.test.js. A
 * one-sided edit forks ATTEST v0 accept/reject at the flag-day.
 *
 ********************************************************************/

// Per-network activation height (LOCAL COPY of the canonical map in
// xchain-documentation/protocol/constants.js). Keyed on the request's own
// block_index, matching the block the responsible set is computed at.
const ATTEST_ADMISSION_ACTIVATION = {
    mainnet: 961000,      // ARMED: BTC anchor ~2026-08-04 (same anchor as STAKE_WEIGHTED_QUORUM); deploy ALL indexers before this height
    testnet: 0,
    regtest: 0,
};

// Whether the admission rejection is in effect for an ATTEST v0 request at
// `blockIndex` on `network`. Below the threshold -> legacy accept-then-expire.
// Unknown network -> off (safe: the legacy path is unchanged).
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
