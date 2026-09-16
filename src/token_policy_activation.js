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
 * TOKEN_POLICY_INHERITANCE_ACTIVATION: where a token's origin-row policy
 * (allow list, block list, tick sleep) starts binding every bridged copy.
 *
 * Kept value-identical to xchain-documentation/protocol/constants.js by
 * test/unit/activationConstantsParity.test.js. A STANDALONE height-keyed
 * module rather than a protocol_changes.js entry (the anchor_activation.js
 * shape), because the hub reads this gate too: the policy poll and the PBFT
 * round that signs an XPOLICY snapshot must stay idle on a pre-activation
 * network, and the hub has neither the indexer's config nor its database
 * layer to find that out.
 *
 * Spec: the token bridge policy spec sections 3 and 9.
 *
 ********************************************************************/

'use strict';

const { get, copy, activeAt } = require('./consensus/gate_registry');

const TOKEN_POLICY_INHERITANCE_ACTIVATION = copy('token_policy_activation.TOKEN_POLICY_INHERITANCE_ACTIVATION');

// Is policy inheritance in effect at height `blockIndex` on `network`? A non-numeric
// height or an unknown network fails closed (false): the milestone-1 refusals then
// stand and no snapshot is applied, which is the safe side of every gated verdict.
function isTokenPolicyInheritanceActive(blockIndex, network){
    let b = parseInt(blockIndex);
    if(!Number.isFinite(b)) return false;
    let threshold = TOKEN_POLICY_INHERITANCE_ACTIVATION[network];
    if(threshold === undefined) return false;
    return b >= threshold;
}

module.exports = { TOKEN_POLICY_INHERITANCE_ACTIVATION, isTokenPolicyInheritanceActive };
