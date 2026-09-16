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

const { get, copy, activeAt } = require('./protocol_changes');

const LIST_OWNER_ACTIVATION = copy('list_owner_activation.LIST_OWNER_ACTIVATION');

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
