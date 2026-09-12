/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XCHAIN_BRIDGE_ACTIVATION: where XBRIDGE v0 (lock), v1 (burn) and v2
 * (mirror-injected settle) become legal.
 *
 * Kept value-identical to xchain-documentation/protocol/constants.js by
 * test/unit/activationConstantsParity.test.js. A STANDALONE height-keyed
 * module rather than a protocol_changes.js entry (the anchor_activation.js
 * shape), because the hub, SDK and explorer read this gate too and
 * protocol_changes.js is indexer-only: the hub engine must stay idle on a
 * pre-activation network, and it cannot require the indexer's config and
 * database layer to find that out.
 *
 * Spec: the base bridge spec sections 7 and 14, D39.
 *
 ********************************************************************/

'use strict';

// XCHAIN_BRIDGE_ACTIVATION: the height (per network) on the chain being parsed at/above
// which XBRIDGE is legal. Below it a broadcast v0 or v1 is 'invalid: XBRIDGE before
// activation' (the per-feature shape anchor.js uses; the central 'invalid: ACTION is not
// yet activated' only fires on software that predates the action) and no v2 is ever
// injected, so pre-activation block hashes are unchanged on every chain.
//
// Keyed on the chain's OWN block_index, never on a transfer's snapshot_block: the row
// being judged is the action mined here. The hub reads the same map against the network
// it federates and never polls below it.
//
// Mainnet is the house sentinel 9999999999: milestone 1 is a hub-trusted mint (spec
// section 12), and nothing arms on mainnet before the D2 checkpoint cross-check lands.
// Testnet stays at the sentinel until the train that arms it sizes a dated instant; a
// height in the map ahead of the fleet's deploy tip is the operator's act, not a build's.
// Regtest is 0 so the e2e rail exercises the armed rule from genesis.
const XCHAIN_BRIDGE_ACTIVATION = {
    mainnet: 9999999999,
    testnet: 9999999999,
    regtest: 0,
};

// Is an XBRIDGE action at height `blockIndex` on `network` at/above the activation? A
// non-numeric height or an unknown network fails closed (false): the action is then
// 'invalid: XBRIDGE before activation', never silently admitted.
function isXchainBridgeActive(blockIndex, network){
    let b = parseInt(blockIndex);
    if(!Number.isFinite(b)) return false;
    let threshold = XCHAIN_BRIDGE_ACTIVATION[network];
    if(threshold === undefined) return false;
    return b >= threshold;
}

module.exports = { XCHAIN_BRIDGE_ACTIVATION, isXchainBridgeActive };
