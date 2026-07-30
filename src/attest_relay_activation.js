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
 * Attestation cross-chain relay flag-day (, external-attestation
 * framework Phase 5 / spec §12).
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
 * ── ACTIVATION PLANE: BTC-ANCHORED SNAPSHOT_BLOCK ──────────────────────────
 *
 * Both legs carry an explicit BTC-anchored SNAPSHOT_BLOCK in their signed
 * canonical, and that is the ONLY value this gate is ever evaluated against.
 * Never a local height: on BTC the two coincide, but on LTC (~3.16M) and DOGE
 * (~6.3M) a BTC-derived threshold is already satisfied by the local height, so
 * gating a v4 on where it landed would ship the rule live instead of inert.
 * That is the documented ATTEST_ADMISSION_ACTIVATION plane trap; see the note
 * in attest_admission_activation.js for the same hazard in its armed form.
 *
 * The origin-side admission relaxation (admitting an LTC/DOGE v0 whose
 * responsible set is empty, so it survives to be relayed instead of being
 * rejected at admission) has no BTC anchor available at the moment it is
 * decided, so it is NOT gated here. It rides the ATTEST_RELAY_ORIGIN block-time
 * gate in protocol_changes.js, which flips every chain at one wall clock.
 * Either order is safe: origin-first admits requests nothing can service yet
 * and they expire on their own deadline (the pre-Phase-5 outcome); BTC-first
 * leaves no origin request to relay.
 *
 * Both versions are new VERSION values on an existing action, so a node that
 * has not been upgraded rejects them as an unknown VERSION while an upgraded
 * one accepts. Every indexer and every hub MUST be deployed before the height.
 *
 * LOCAL COPY of the canonical map in
 * xchain-documentation/protocol/constants.js (ATTEST_RELAY_ACTIVATION); kept
 * value-identical by xchain-indexer/test/unit/activationConstantsParity.test.js.
 * Two byte-identical copies exist and BOTH are named here, so this header reads
 * true from either file rather than pointing at itself:
 *   xchain-indexer/src/attest_relay_activation.js
 *   xchain-hub/src/attest_relay_activation.js
 * A one-sided edit forks relay acceptance at the flag-day, which is why
 * attestRelayActivationParity.test.js asserts the two are byte-equal.
 *
 ********************************************************************/

// Per-network activation height, interpreted as the BTC-anchored SNAPSHOT_BLOCK
// carried by the relay canonical (NOT the local processing height), so BTC, LTC,
// DOGE and the hub all flip the relay legs on one anchor.
const ATTEST_RELAY_ACTIVATION = {
    mainnet: 969500,      // ARMED 2026-07-30  on the ratified  BTC anchor; deploy every indexer + hub before this height
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
