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

const { get, copy, activeAt } = require('./consensus/gate_registry');

const XCHAIN_BRIDGE_ACTIVATION = copy('xchain_bridge_activation.XCHAIN_BRIDGE_ACTIVATION');

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
