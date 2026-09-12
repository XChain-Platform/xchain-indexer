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

// TOKEN_POLICY_INHERITANCE_ACTIVATION: the height (per network) on the chain being
// parsed at/above which policy inheritance is in effect. Keyed on the chain's OWN
// block_index, never on a snapshot's snapshot_block or origin_block, because what it
// gates is the verdict of an action mined here.
//
// What it gates, all of it consensus-visible:
//   - the milestone-1 refusals lifted in issue.js (format 7 on a listed token; format
//     5, and a format 0 carrying lists, on a bridged token);
//   - any-coin address items in list.js and the same widening in db.isAddressSleeping;
//   - application of a mirrored policy_snapshots row on the destination, and with it
//     the in-leg barrier that holds a v5 credit until the tick has a policy;
//   - the hub engine's policy poll, so no XPOLICY row is signed below it.
//
// Below it every milestone-1 verdict stands unchanged, so the replay corpus is
// hash-identical on every chain with this code present.
//
// Mainnet and testnet are the house sentinel 9999999999: this rides the same MAJOR
// train as the two bridges and the operator sizes the dated instant at the cut. A
// height in the map ahead of the fleet's deploy tip is the operator's act, not a
// build's. Regtest is 0 so the e2e rail exercises the armed rule from genesis.
//
// TWO ORDERING INVARIANTS, asserted by test/unit/activationConstantsParity.test.js
// over the canonical constants.js rather than over this copy:
//   - >= TOKEN_BRIDGE_ACTIVATION per network. Inheritance has nothing to inherit onto
//     before bridged copies can exist.
//   - >= LIST_EDIT_RESOLUTION_ACTIVATION per chain and network. The snapshot read
//     resolves a list AS OF origin_block through getListAtBlock, which walks the edit
//     chain; below that gate the legacy create-index read runs and the membership the
//     federation signs would not be the membership the chain actually held.
const TOKEN_POLICY_INHERITANCE_ACTIVATION = {
    mainnet: 9999999999,
    testnet: 9999999999,
    regtest: 0,
};

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
