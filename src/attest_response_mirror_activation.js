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
 * ATTEST response mirror activation (the ATTEST response-mirror design).
 *
 * WHAT FLIPS AT THIS HEIGHT. Below it an attestation costs TWO on-chain
 * transactions: the v0 request rides inside the EXECUTE the user already paid
 * for, but the response is a whole ATTEST v1 transaction the leader validator
 * broadcasts and pays a fee for, and the contract callback fires only when it
 * mines. At or above it the finalized response never touches the chain as its
 * own transaction: it is written to the hub's attestation_responses table,
 * gossiped to the whole federation, streamed to every indexer through the hub
 * mirror, and applied at a block that is a pure function of the SIGNED
 * effective_time and the indexer's own chain state. The full history still
 * reaches the chain, in periodic ATTEST v5/v6 batches, so a node that replays
 * the chain alone re-derives every callback.
 *
 * ACTIVATION PLANE: the REQUEST's own BTC block_index, never the response's,
 * exactly like ATTEST_RESPONSIBLE_WIDENING_ACTIVATION and
 * ATTEST_ADMISSION_ACTIVATION. This is what makes the rule for a given request
 * fixed the moment it is admitted, so a request cannot be admitted under the
 * on-chain regime and then answered under the mirror one (or the reverse) while
 * the fleet crosses the height. It is also why the two eras never share a
 * signature: the canonical the responsible set signs is selected by the same
 * height (the mirror-era canonical appends the signed effective_time), so a
 * signature valid in one era cannot be replayed into the other.
 *
 * A RELAYED REQUEST (a v0 admitted on LTC or DOGE and materialized on BTC as an
 * ATTEST v3) is served on BTC, so the v3's BTC block keys the gate. Nothing on
 * the origin plane changes.
 *
 * MAINNET IS null, THE INERT SENTINEL, and the legacy path runs byte for byte
 * there. Testnet is operator-armed after the regtest milestone, sized to the
 * deploy wave the way the widening ladder's 150780 was; it is deliberately NOT 0,
 * because TBTC already carries real attestation history (requests 60, 106, 136)
 * that must keep replaying under the rules it was answered by. Regtest is 0 so
 * the e2e mirror venue exercises the mirror path from genesis.
 *
 * DEPLOY ORDER DOES NOT SAVE US HERE, unlike the widening ladder. There the
 * safety came from only an upgraded hub being able to PRODUCE a widened v1. Here
 * an upgraded hub stops broadcasting v1 entirely, so an indexer that has not
 * upgraded would simply never see the response. The height therefore has to be
 * armed past a SYNCHRONIZED fleet window (hubs, indexers and explorer together,
 * the HUB_SCHEMA_VERSION 4->5 flip), and no request may straddle it.
 *
 * LOCAL COPY of the canonical map in xchain-documentation/protocol/constants.js
 * and the byte-twin of xchain-hub/src/attest_response_mirror_activation.js; kept
 * value-identical by the activation-constants parity suite. A one-sided edit
 * forks attestation settlement at the flag-day.
 *
 ********************************************************************/

'use strict';

// Per-network activation height (LOCAL COPY, parity-tested). Compared against
// the ATTEST v0 request's own BTC block_index (the v3's, for a relayed request).
const ATTEST_RESPONSE_MIRROR_ACTIVATION = {
    mainnet: null,        // INERT: operator-owned height, unratified. The legacy on-chain response path runs byte for byte.
    testnet: null,        // UNARMED: operator-armed after the regtest milestone is REACHED and the synchronized schema-5 fleet window closes.
    regtest: 0,           // ARMED at genesis so the e2e mirror venue exercises the mirror path
};

// True when the response to a request admitted at `requestBlock` is served by the
// mirror rather than by an on-chain ATTEST v1.
//
// Returns false whenever the network is unratified or the height is unusable, which
// is the legacy path byte for byte. `null` is the UNRATIFIED sentinel and must read
// as "off": without the explicit null test `req >= null` coerces to `req >= 0` and
// arms the mirror on every block of an unratified network, the inverse of what the
// sentinel means (the same trap ATTEST_RESPONSIBLE_WIDENING_ACTIVATION documents).
function isResponseMirrorActive(requestBlock, network){
    let threshold = ATTEST_RESPONSE_MIRROR_ACTIVATION[network];
    if(threshold === null || threshold === undefined) return false;
    let req = parseInt(requestBlock);
    if(!Number.isFinite(req)) return false;
    return req >= threshold;
}

module.exports = {
    ATTEST_RESPONSE_MIRROR_ACTIVATION,
    isResponseMirrorActive
};
