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
 * LIST edit resolution flag-day .
 *
 * A LIST edit (format 1) splices ADD/REMOVE into the parent's membership and
 * writes the resulting item set through createListItem, which keys rows on the
 * EDIT transaction's OWN action_index. The parent list's list_items rows are
 * never touched. Every consumer pins a list by the CREATE action_index
 * (bet_feeds.allow_list / block_list, tokens.allow_list / block_list,
 * orders/swaps/dispensers, AIRDROP's LIST_ACTION_INDEX), so getList(createIndex)
 * returned create-time membership forever and on-chain lists were effectively
 * immutable: an owner could neither revoke nor grant membership after create.
 *
 * THE FIX IS ON THE READ PATH. Each valid edit already persists a COMPLETE
 * snapshot of the resulting membership (list.js builds the final item array, not
 * a delta), so the current membership of a list is exactly "the item rows of the
 * newest valid action in its edit chain". getList resolves that head instead of
 * reading the create's rows. Nothing is mutated in place, which is why this does
 * NOT need the BET-latch treatment (block stamp + rollback reset + state-hash
 * class) that remapping the edit's writes onto the parent's action_index would:
 * every row stays owned by the action that wrote it, so the existing
 * action-scoped replication (stream:action) and the generic action-scoped
 * rollback delete are already correct. Orphaning an edit in a reorg deletes its
 * lists + list_items rows, and resolution falls back to the previous head by
 * construction.
 *
 * It IS consensus-affecting: getList feeds allow/block gating for BET place,
 * ORDER/SWAP match, DISPENSE, DIVIDEND, CALLBACK, AIRDROP and isActionAllowed,
 * so which actions are accepted changes at any height where a list carries an
 * edit. Replaying history under the new rule would diverge from nodes that
 * already processed those blocks under the old one, hence the per-chain flag
 * day, keyed on the chain's OWN local block_index exactly like the state-hash
 * activation maps. Below the threshold (and whenever the caller has no block
 * context) the legacy create-index read runs, so historical replay stays
 * byte-identical.
 *
 * EXECUTION-PATH gate (which actions validate), NOT a hashing-path change, so
 * this is INDEXER-ONLY with no xchain-sync twin: xchain-sync replicates
 * materialized rows and never runs an action handler or getList.
 *
 ********************************************************************/

// Per-chain activation heights, interpreted against the chain's own
// block_index. Pinned to the  pre-freeze activation train, the same
// cohort as BET_STATUS_STATE_HASH_ACTIVATION in stateHash.js: BET members-only
// markets are the loudest consumer of a mutable list, so the two flip together
// and operators reason about one boundary. RE-PINNED 2026-07-27 against live tips
// in lockstep with that map (read its header for the rule and for the LTC:testnet
// height the chain had already passed). These two maps must stay equal value for
// value; the explorer vendors this one byte-identically behind a guard test.
// CONFIRM again at train assembly: they are only as good as the day measured.
const LIST_EDIT_RESOLUTION_ACTIVATION = {
    'BTC:mainnet':  963000,   // tip 959,853 (2026-07-27) + 21d @144/day = 962,877
    'LTC:mainnet':  3162000,   // tip 3,149,481 + 21d @576/day = 3,161,577
    'DOGE:mainnet': 6338000,   // tip 6,307,307 + 21d @1440/day = 6,337,547
    'BTC:testnet':  149500,   // tip 145,963; keeps the wider existing margin
    'LTC:testnet':  4837000,   // tip 4,824,850 had already PASSED the old 4,823,000
    'DOGE:testnet': 68000000,   // fast chain, wide margin; tip 67,789,569
    regtest: 0,                 // armed from genesis: fresh regtest stacks exercise list edits end to end
};

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
