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
 * TOKEN_BRIDGE_ACTIVATION: where the GENERAL token bridge becomes legal -
 * XBRIDGE v3 (lock), v4 (burn), v5 (mirror-injected settle) and ISSUE
 * format 7 (the issuer's bridgeability opt-in).
 *
 * Kept value-identical to xchain-documentation/protocol/constants.js by
 * test/unit/activationConstantsParity.test.js, which also asserts the ORDERING
 * invariant TOKEN_BRIDGE_ACTIVATION >= XCHAIN_BRIDGE_ACTIVATION per network:
 * the general formats ride the same engine, the same mirror table and the same
 * settle pass as XCHAIN's, so a train that armed v3 without the XCHAIN bridge
 * behind it would admit a lock nothing can ever finalize.
 *
 * Standalone height-keyed module for the same reason as
 * xchain_bridge_activation.js: the hub, SDK and explorer read it too.
 *
 * Spec: the token bridge spec sections 5, 7 and 8, D25.
 *
 ********************************************************************/

'use strict';

const { get, copy, activeAt } = require('./consensus/gate_registry');

const TOKEN_BRIDGE_ACTIVATION = copy('token_bridge_activation.TOKEN_BRIDGE_ACTIVATION');

// Is a general-token bridge action at height `blockIndex` on `network` at/above the
// activation? A non-numeric height or an unknown network fails closed (false).
function isTokenBridgeActive(blockIndex, network){
    let b = parseInt(blockIndex);
    if(!Number.isFinite(b)) return false;
    let threshold = TOKEN_BRIDGE_ACTIVATION[network];
    if(threshold === undefined) return false;
    return b >= threshold;
}

module.exports = { TOKEN_BRIDGE_ACTIVATION, isTokenBridgeActive };
