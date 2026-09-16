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
 * LIST edit resolution flag-day.
 *
 * A LIST edit (format 1) splices ADD/REMOVE into the parent's membership and
 * writes the resulting item set through createListItem, keyed on the EDIT
 * transaction's OWN action_index; the parent list's list_items rows are never
 * touched. Every consumer pins a list by the CREATE action_index (bet feed
 * allow/block lists, token allow/block lists, orders/swaps/dispensers,
 * AIRDROP's LIST_ACTION_INDEX), so getList(createIndex) returned create-time
 * membership forever and on-chain lists were effectively immutable: an owner
 * could neither revoke nor grant membership after create.
 *
 * THE FIX IS ON THE READ PATH. Each valid edit already persists a COMPLETE
 * snapshot of the resulting membership (list.js builds the final item array, not
 * a delta), so the current membership of a list is exactly "the item rows of the
 * newest valid action in its edit chain". getList resolves that head instead of
 * reading the create's rows. Nothing is mutated in place: every row stays owned
 * by the action that wrote it, so the existing action-scoped replication and
 * rollback delete are already correct, and a reorg that orphans an edit falls
 * back to the previous head by construction.
 *
 * It IS consensus-affecting: getList feeds allow/block gating for BET place,
 * ORDER/SWAP match, DISPENSE, DIVIDEND, CALLBACK, AIRDROP and isActionAllowed,
 * so which actions are accepted changes at any height where a list carries an
 * edit. Replaying history under the new rule would diverge from nodes that
 * already processed those blocks under the old one, hence the per-chain flag
 * day, keyed on the chain's OWN local block_index. Below the threshold (and
 * whenever the caller has no block context) the legacy create-index read runs,
 * so historical replay stays byte-identical.
 *
 * EXECUTION-PATH gate (which actions validate), NOT a hashing-path change, so
 * this is INDEXER-ONLY with no xchain-sync twin: xchain-sync replicates
 * materialized rows and never runs an action handler or getList.
 *
 ********************************************************************/

const { get, copy, activeAt } = require('./consensus/gate_registry');

const LIST_EDIT_RESOLUTION_ACTIVATION = copy('list_edit_resolution_activation.LIST_EDIT_RESOLUTION_ACTIVATION');

// Per-chain threshold with a network-wide fallback, byte-for-byte the lookup
// stateHash.js uses. A coin-less caller (unit fixtures) falls through to the
// bare network key and stays inert on mainnet/testnet, which is the safe side.
function _activationThreshold(map, network, coin){
    if(coin != null && map[coin + ':' + network] !== undefined) return map[coin + ':' + network];
    return map[network];
}

// Whether edit-chain resolution is in effect for a block on `network`/`coin`.
// Below the threshold, an unparseable/absent block_index, or an unknown network
// -> off (legacy create-index read; historical replay byte-identical).
function isListEditResolutionActive(blockIndex, network, coin){
    let b = parseInt(blockIndex);
    if(!Number.isFinite(b)) return false;
    let threshold = _activationThreshold(LIST_EDIT_RESOLUTION_ACTIVATION, network, coin);
    if(threshold === undefined) return false;
    return b >= threshold;
}

module.exports = {
    LIST_EDIT_RESOLUTION_ACTIVATION,
    isListEditResolutionActive
};
