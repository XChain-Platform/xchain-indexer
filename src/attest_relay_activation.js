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
 * Attestation cross-chain relay flag-day (external-attestation framework
 * Phase 5, spec section 12).
 *
 * Gates acceptance of the two relay legs that let an LTC or DOGE contract use
 * the attestation framework, whose validators and capability stake live only on
 * BTC:
 *
 *   ATTEST v3 (on BTC)    an origin-chain request materialized onto BTC by the
 *                         cross_chain federation, carrying 2f+1 signatures. The
 *                         v3's own BTC block_index becomes the request's
 *                         block_index, so the responsible set and the block-echo
 *                         determinism check resolve on the BTC plane exactly as
 *                         they do for a natively emitted request.
 *   ATTEST v4 (on origin) the BTC response relayed back, same signature rail.
 *                         The origin indexer flips its pending request terminal
 *                         and injects the contract callback.
 *
 * ACTIVATION PLANE: BTC-ANCHORED SNAPSHOT_BLOCK, never a local height. Both
 * legs carry an explicit BTC-anchored SNAPSHOT_BLOCK in their signed
 * canonical, and that is the only value this gate is evaluated against: on
 * LTC (~3.16M) and DOGE (~6.3M) a BTC-derived threshold is already satisfied
 * by the local height, so gating a v4 on where it landed would ship the rule
 * live instead of inert (the same plane trap documented in
 * attest_admission_activation.js).
 *
 * The origin-side admission relaxation (admitting an LTC/DOGE v0 whose
 * responsible set is empty, so it survives to be relayed rather than
 * rejected at admission) has no BTC anchor available at the moment it is
 * decided, so it rides a separate block-time gate (ATTEST_RELAY_ORIGIN in
 * protocol_changes.js) that flips every chain at one wall clock instead.
 * Either deploy order is safe: origin-first just lets requests expire on
 * their own deadline until BTC-side lands; BTC-first leaves no origin
 * request to relay yet.
 *
 * Both versions are new VERSION values on an existing action, so an
 * unupgraded node rejects them as unknown while an upgraded one accepts.
 * Every indexer and every hub must be deployed before the height.
 *
 * A byte-identical twin of this map lives in
 * xchain-hub/src/attest_relay_activation.js (and in
 * xchain-documentation/protocol/constants.js); a parity test keeps all
 * copies byte-equal, since a one-sided edit forks relay acceptance.
 *
 ********************************************************************/

// Per-network activation height, interpreted as the BTC-anchored SNAPSHOT_BLOCK
// carried by the relay canonical (NOT the local processing height), so BTC, LTC,
// DOGE and the hub all flip the relay legs on one anchor.
const ATTEST_RELAY_ACTIVATION = {
    mainnet: 963000,      // ARMED 2026-07-30, RE-PINNED 2026-08-12 off block 969500 with the rest of the coordinated mainnet activation cohort; deploy every indexer + hub before this height
    testnet: 0,
    regtest: 0,
};

// Whether the ATTEST relay legs are accepted for a relay whose BTC-anchored
// snapshot is at `snapshotBlock` on `network`. Below the threshold -> off (the
// legs are rejected as an unknown VERSION, byte-identical to pre-Phase-5
// replay). Unknown network -> off (safe).
function isAttestRelayActive(snapshotBlock, network){
    let sb = parseInt(snapshotBlock);
    if(!Number.isFinite(sb)) return false;
    let threshold = ATTEST_RELAY_ACTIVATION[network];
    if(threshold === undefined) return false;
    return sb >= threshold;
}

module.exports = {
    ATTEST_RELAY_ACTIVATION,
    isAttestRelayActive
};
