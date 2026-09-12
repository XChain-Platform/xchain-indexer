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
 * Spec: the base bridge spec sections 7 and 14, D39, row 28 (coin-keyed).
 *
 ********************************************************************/

'use strict';

// XCHAIN_BRIDGE_ACTIVATION: the height on the chain being parsed at/above which XBRIDGE is
// legal. Below it a broadcast v0 or v1 is 'invalid: XBRIDGE before activation' (the
// per-feature shape anchor.js uses; the central 'invalid: ACTION is not yet activated' only
// fires on software that predates the action) and no v2 is ever injected, so pre-activation
// block hashes are unchanged on every chain.
//
// Keyed on the chain's OWN block_index, never on a transfer's snapshot_block: the row being
// judged is the action mined here. The hub reads the same map for the chain a leg was mined
// on, and signs nothing for a chain that has not reached its own height.
//
// KEYED '<COIN>:<network>', with the bare network key as the fallback (the shape
// stake_key_reuse_activation.js already uses one map over). One testnet number cannot serve
// three chains: the bridge arms on TBTC, TLTC and TDOGE, whose tips differ by orders of
// magnitude (about 152,110 / 4,884,193 / 67,889,993 measured 2026-09-12), so a single height
// is either already passed on two of them at boot or unreachable on the third. A coin with
// no entry of its own inherits the bare network key, which leaves an unlisted chain inert
// rather than undecided.
//
// Mainnet is the house sentinel 9999999999 on every key: milestone 1 is a hub-trusted mint
// (spec section 12), and nothing arms on mainnet before the D2 checkpoint cross-check lands.
// Testnet holds at the same sentinel on every key: the train that arms it sizes one dated
// instant PER CHAIN, strictly above that chain's own deploy tip, and a height written here is
// the operator's act at that train, never a build's. Regtest is 0 and stays bare, because one
// regtest number fits every chain and the e2e rail exercises the armed rule from genesis.
const XCHAIN_BRIDGE_ACTIVATION = {
    'BTC:mainnet':  9999999999,
    'LTC:mainnet':  9999999999,
    'DOGE:mainnet': 9999999999,
    mainnet:        9999999999,   // fallback for a coin with no entry above
    'BTC:testnet':  9999999999,   // the arming train sizes this at the measured TBTC tip
    'LTC:testnet':  9999999999,   // the arming train sizes this at the measured TLTC tip
    'DOGE:testnet': 9999999999,   // the arming train sizes this at the measured TDOGE tip
    testnet:        9999999999,   // fallback: a testnet coin with no entry above stays dark
    regtest:        0,            // genesis-active so the e2e rail exercises the armed rule
};

// Resolve the per-chain threshold: the '<COIN>:<network>' key when the map declares one,
// otherwise the bare network key. An unknown network resolves to undefined, which reads as
// inert below.
function _activationThreshold(network, coin){
    if(coin != null && XCHAIN_BRIDGE_ACTIVATION[coin + ':' + network] !== undefined)
        return XCHAIN_BRIDGE_ACTIVATION[coin + ':' + network];
    return XCHAIN_BRIDGE_ACTIVATION[network];
}

// Is an XBRIDGE action at height `blockIndex` on `network` for `coin` at/above the
// activation? A non-numeric height, an unknown network or an inert (null) threshold fails
// closed (false): the action is then 'invalid: XBRIDGE before activation', never silently
// admitted. The null test is not decoration; without it `b >= null` coerces to `b >= 0` and
// arms the gate on every block of an unratified chain, the inverse of what a sentinel means.
function isXchainBridgeActive(blockIndex, network, coin){
    let b = parseInt(blockIndex);
    if(!Number.isFinite(b)) return false;
    let threshold = _activationThreshold(network, coin);
    if(threshold === null || threshold === undefined) return false;
    return b >= threshold;
}

module.exports = { XCHAIN_BRIDGE_ACTIVATION, isXchainBridgeActive };
