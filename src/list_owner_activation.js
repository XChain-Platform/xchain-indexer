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
 * LIST_OWNER_ACTIVATION: where a LIST format 1 (edit) must come from the
 * address that created the list.
 *
 * The hole this closes, measured 2026-09-11 (found by the
 * policy-inheritance review): list.js format 1 validates EDIT,
 * LIST_ACTION_INDEX, MEMO and the items, and uses SOURCE only for the sleep
 * check. Nothing anywhere compares the editor to the list's creator, so any
 * address can add to or remove from any issuer's allow or block list on any
 * chain, including the live testnet. Every handler that enforces a list then
 * enforces the edited membership.
 *
 * Why a flag day for a fix this plainly right: the check RE-VERDICTS history.
 * A third-party edit that was 'valid' when it was mined becomes
 * 'invalid: LIST_ACTION_INDEX (not owner)' on replay, which moves actions_hash
 * and, through the memberships those edits changed, every downstream verdict
 * that read them. So the rule arms at a height and every chain's replay corpus
 * stays hash-identical below it.
 *
 * Kept value-identical to xchain-documentation/protocol/constants.js by
 * test/unit/activationConstantsParity.test.js.
 *
 * Spec: the token bridge policy spec section 12 row 11.
 *
 ********************************************************************/

'use strict';

// LIST_OWNER_ACTIVATION: the height (per network) on the chain being parsed at/above
// which a LIST format 1 whose SOURCE is not the source of the list's root create is
// 'invalid: LIST_ACTION_INDEX (not owner)'. Keyed on the chain's OWN block_index: the
// action being judged is the edit mined here.
//
// Mainnet and testnet park at the house sentinel 9999999999 and the operator sizes the
// dated instant at the v0.18.0 cut, because arming a re-verdicting rule at a height the
// fleet has already passed would have a replaying node apply it where a long-running
// node never did, and the two diverge at the first hash comparison. Regtest is 0 so the
// e2e rail exercises the armed rule from genesis.
//
// A network map rather than the per-chain 'COIN:network' shape
// list_edit_resolution_activation.js uses: that gate had to be pinned against three live
// mainnet tips because it was arming into indexed history, while this one arms nowhere
// off regtest until the operator names an instant, and a per-chain map would be three
// sentinels to keep equal instead of one.
const LIST_OWNER_ACTIVATION = {
    mainnet: 9999999999,
    testnet: 9999999999,
    regtest: 0,
};

// Is the LIST owner check in effect at height `blockIndex` on `network`? A non-numeric
// height or an unknown network fails closed (false), which here means the LEGACY rule:
// the edit is judged exactly as it was before this file existed. Failing closed toward
// the historical verdict is what keeps replay identical when a caller has no block
// context.
function isListOwnerCheckActive(blockIndex, network){
    let b = parseInt(blockIndex);
    if(!Number.isFinite(b)) return false;
    let threshold = LIST_OWNER_ACTIVATION[network];
    if(threshold === undefined) return false;
    return b >= threshold;
}

module.exports = { LIST_OWNER_ACTIVATION, isListOwnerCheckActive };
