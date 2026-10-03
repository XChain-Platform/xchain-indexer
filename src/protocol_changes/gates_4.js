/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * Indexer-only registry rows, part 4 of 4: post-split additions
 *
 * Rows added after gates_3.js reached the file-size limit. Each row stays
 * grouped by module stem and retains registry insertion order.
 *
 ********************************************************************/

'use strict';

const { addGate, UNARMED } = require('./shared_rows.js');

// dispenser_freshness_proven_use_activation
// DISPENSER_FRESHNESS_PROVEN_USE_ACTIVATION: at/after this block time the local
// fresh-address verdict counts only activity that proves use of GET_ADDRESS (it was
// the SOURCE of an action, was credited, or is the GET_ADDRESS of a valid dispenser),
// so a mention in someone else's LIST no longer spends the exception. Below it any
// index_addresses row counts, byte-identically. Keyed on block time like the other
// dispenser-family rows. Unarmed on mainnet and testnet until a release names the instant.
addGate('dispenser_freshness_proven_use_activation.DISPENSER_FRESHNESS_PROVEN_USE_ACTIVATION', 'time', {
    mainnet: UNARMED,
    'BTC:testnet': 1791039938,
    'LTC:testnet': 1791039938,
    'DOGE:testnet': 1791039938,
    testnet: UNARMED,
    regtest: 0,
});

// dispenser_settlement_price_activation: against data['BLOCK_TIME']. A FIAT create or refill
// needs the price a DISPENSE at that block would settle against (Mode A snapshot, Mode B pair).
addGate('dispenser_settlement_price_activation.DISPENSER_SETTLEMENT_PRICE_ACTIVATION', 'time', {
    mainnet: UNARMED,       // UNARMED (house sentinel) until a release names the instant
    'BTC:testnet': 1791039938,
    'LTC:testnet': 1791039938,
    'DOGE:testnet': 1791039938,
    testnet: UNARMED,       // UNARMED: testnet carries live FIAT creates this would re-judge
    regtest: 0,
});

// empty_allow_list_denies_activation
// At or above this height an attached ALLOW_LIST that resolves to no members
// denies every address in ORDER_MATCH, SWAP_MATCH and CALLBACK. Below it those
// consumers retain their legacy empty-list fail-open behavior.
addGate('empty_allow_list_denies_activation.EMPTY_ALLOW_LIST_DENIES', 'height', {
    mainnet: UNARMED,
    'BTC:testnet': 154971,
    'LTC:testnet': 4905844,
    'DOGE:testnet': 67961578,
    testnet: UNARMED,
    regtest: 0,
});

// list_edit_remove_activation
// LIST_EDIT_REMOVE_ACTIVATION: at/after this block time a Version 2 DISPENSER, ORDER or
// SWAP edit may carry `0` in ALLOW_LIST or BLOCK_LIST to remove that list. No LIST has
// ACTION_INDEX 0, so below it `0` stays 'invalid: <field> (unknown)' and no valid edit
// row can hold it. Keyed on block time; unarmed on mainnet and testnet until a release
// names the instant.
addGate('list_edit_remove_activation.LIST_EDIT_REMOVE_ACTIVATION', 'time', {
    mainnet: UNARMED,
    'BTC:testnet': 1791039938,
    'LTC:testnet': 1791039938,
    'DOGE:testnet': 1791039938,
    testnet: UNARMED,
    regtest: 0,
});

// token_gate_list_at_block
// At or above this height address-plus-token policy checks resolve token state and
// LIST membership at the action's block. Below it they retain the unbounded
// legacy lookup so historical replay remains byte-identical.
addGate('token_gate_list_at_block.TOKEN_GATE_LIST_AT_BLOCK', 'height', {
    mainnet: UNARMED,
    'BTC:testnet': 154971,
    'LTC:testnet': 4905844,
    'DOGE:testnet': 67961578,
    testnet: UNARMED,
    regtest: 0,
});

// order_swap_maker_policy_admission
// At or above this height a local ORDER or SWAP maker's GET_ADDRESS must pass
// both token policies before the GIVE side enters escrow.
addGate('order_swap_maker_policy_admission.ORDER_SWAP_MAKER_POLICY_ADMISSION', 'height', {
    mainnet: UNARMED,
    'BTC:testnet': 154971,
    'LTC:testnet': 4905844,
    'DOGE:testnet': 67961578,
    testnet: UNARMED,
    regtest: 0,
});

// list_reference_validity_activation
// Require referenced LIST actions to carry a valid verdict. Below activation,
// reference validation accepts any stored LIST row of the right type. An invalid
// stored reference counts as no list for policy consumers after activation.
addGate('list_reference_validity_activation.LIST_REFERENCE_REQUIRES_VALID_LIST', 'height', {
    mainnet: UNARMED,
    'BTC:testnet': 154971,
    'LTC:testnet': 4905844,
    'DOGE:testnet': 67961578,
    testnet: UNARMED,
    regtest: 0,
});

// list_head_follows_edit_chain
// At or above this height, LIST head resolution follows legacy edits that
// reference another edit instead of only considering direct children of CREATE.
addGate('list_head_follows_edit_chain.LIST_HEAD_FOLLOWS_EDIT_CHAIN', 'height', {
    mainnet: UNARMED,
    'BTC:testnet': 154971,
    'LTC:testnet': 4905844,
    'DOGE:testnet': 67961578,
    testnet: UNARMED,
    regtest: 0,
});

// callback_compensation_activation
// Reject a CALLBACK when a holder of the recalled TICK cannot receive the
// CALLBACK_TICK compensation. Below this height legacy settlement is retained.
addGate('callback_compensation_activation.CALLBACK_COMPENSATES_EVERY_DEBITED_HOLDER', 'height', {
    mainnet: UNARMED,
    'BTC:testnet': 154971,
    'LTC:testnet': 4905844,
    'DOGE:testnet': 67961578,
    testnet: UNARMED,
    regtest: 0,
});

// vote_callback_binding_activation
// Require a VOTE binding callback to target a currently active contract and a
// callable export. Below this height creation checks only contract existence.
addGate('vote_callback_binding_activation.VOTE_CALLBACK_BINDING_REQUIRES_USABLE_METHOD', 'height', {
    mainnet: UNARMED,
    'BTC:testnet': 154971,
    'LTC:testnet': 4905844,
    'DOGE:testnet': 67961578,
    testnet: UNARMED,
    regtest: 0,
});

// order_swap_payout_policy_activation
// At or above this height, each ORDER or SWAP payout address is checked only
// against the generic policy of the token delivered to it.
addGate('order_swap_payout_policy_activation.ORDER_SWAP_PAYOUT_POLICY_PER_TOKEN', 'height', {
    mainnet: UNARMED,
    'BTC:testnet': 154971,
    'LTC:testnet': 4905844,
    'DOGE:testnet': 67961578,
    testnet: UNARMED,
    regtest: 0,
});

// issue_policy_list_detach
// At or above this height an ISSUE format 5 may carry `0` in ALLOW_LIST or
// BLOCK_LIST to detach that policy list. Empty fields inherit current ids.
addGate('issue_policy_list_detach.ISSUE_POLICY_LIST_DETACH', 'height', {
    mainnet: UNARMED,
    'BTC:testnet': 154971,
    'LTC:testnet': 4905844,
    'DOGE:testnet': 67961578,
    testnet: UNARMED,
    regtest: 0,
});

// bridge_policy_detach_activation
// Read by the bridge policy settle pass at the destination chain's own block index.
// At or above it a signed snapshot whose allow or block list is null detaches the bridged copy's matching list; below it a null list leaves the copy's list attached (byte-identical replay).
// It must never arm ahead of issue_policy_list_detach.ISSUE_POLICY_LIST_DETACH, whose `0` sentinel it injects.
addGate('bridge_policy_detach_activation.BRIDGE_POLICY_DETACH', 'height', {
    mainnet: UNARMED,
    'BTC:testnet': 154971,
    'LTC:testnet': 4905844,
    'DOGE:testnet': 67961578,
    testnet: UNARMED,
    regtest: 0,
});

// vm_lint_optional_chain_heights
// Per-chain height on the processing chain's own block_index. At or after it,
// the deploy-lint global-object and Math-object matchers also look through a
// parenthesized optional chain. Mainnet is unarmed by ruling, and testnet stays
// unarmed until a measured height is armed. MUST equal xchain-vm
// LINT_OPTIONAL_CHAIN_ACTIVATION, whose null is this row's UNARMED.
addGate('vm_lint_optional_chain_heights.VM_LINT_OPTIONAL_CHAIN_ACTIVATION', 'height', {
    'BTC:mainnet': UNARMED,
    'LTC:mainnet': UNARMED,
    'DOGE:mainnet': UNARMED,
    'BTC:testnet': 154971,
    'LTC:testnet': 4905844,
    'DOGE:testnet': 67961578,
    testnet: UNARMED,
    regtest: 0,
});

// swap_edit_rematch_activation
// At or above this height a SWAP edit looks for matches against the resting
// swap it updates. Below it the lookup retains the edit action index.
addGate('swap_edit_rematch_activation.SWAP_EDIT_REMATCH_ACTIVATION', 'height', {
    mainnet: UNARMED,
    'BTC:testnet': 154971,
    'LTC:testnet': 4905844,
    'DOGE:testnet': 67961578,
    testnet: UNARMED,
    regtest: 0,
});

// market_list_source_activation
// At or above this height each ORDER or SWAP also applies its own allow and
// block lists to the counterparty's SOURCE. Existing GET_ADDRESS checks remain.
addGate('market_list_source_activation.MARKET_LIST_SOURCE_ACTIVATION', 'height', {
    mainnet: UNARMED,
    'BTC:testnet': 154777,
    'LTC:testnet': 4905004,
    'DOGE:testnet': 67956922,
    testnet: UNARMED,
    regtest: 0,
});

// list_change_rematch_activation
// At or above this height a valid address LIST create or edit re-runs matching
// for open ORDERs and SWAPs whose own policy resolves to the changed list.
addGate('list_change_rematch_activation.LIST_CHANGE_REMATCH_ACTIVATION', 'height', {
    mainnet: UNARMED,
    'BTC:testnet': 154777,
    'LTC:testnet': 4905004,
    'DOGE:testnet': 67956922,
    testnet: UNARMED,
    regtest: 0,
});

// list_share_activation
// At or above this height LIST format 2, shared-edit fees and the shared-list
// member cap are active on the chain being parsed.
addGate('list_share_activation.LIST_SHARE_ACTIVATION', 'height', {
    mainnet: UNARMED,
    'BTC:testnet': 154777,
    'LTC:testnet': 4905004,
    'DOGE:testnet': 67956922,
    testnet: UNARMED,
    regtest: 0,
});

// list_union_activation
// At or above this height LIST type 3 resolves the union of its member lists.
addGate('list_union_activation.LIST_UNION_ACTIVATION', 'height', {
    mainnet: UNARMED,
    'BTC:testnet': 154777,
    'LTC:testnet': 4905004,
    'DOGE:testnet': 67956922,
    testnet: UNARMED,
    regtest: 0,
});

// list_transfer_activation
// At or above this height LIST format 3 transfers ownership to its destination.
addGate('list_transfer_activation.LIST_TRANSFER_ACTIVATION', 'height', {
    mainnet: UNARMED,
    'BTC:testnet': 154777,
    'LTC:testnet': 4905004,
    'DOGE:testnet': 67956922,
    testnet: UNARMED,
    regtest: 0,
});

// list_address_ref_activation
// At or above this height an address LIST item may use an index-id reference.
addGate('list_address_ref_activation.LIST_ADDRESS_REF_ACTIVATION', 'height', {
    mainnet: UNARMED,
    'BTC:testnet': 154777,
    'LTC:testnet': 4905004,
    'DOGE:testnet': 67956922,
    testnet: UNARMED,
    regtest: 0,
});

addGate('protocol/constants.LIST_SHARE_MAX_MEMBERS', 'constant', 10000);
addGate('protocol/constants.LIST_META_NAME_MAX_BYTES', 'constant', 64);
addGate('protocol/constants.LIST_META_DESCRIPTION_MAX_BYTES', 'constant', 512);
addGate('protocol/constants.LIST_UNION_MAX_MEMBERS', 'constant', 16);

// list_tick_coin_activation
addGate('list_tick_coin_activation.LIST_TICK_COIN_ACTIVATION', 'height', {
    mainnet: UNARMED,
    testnet: UNARMED,
    'BTC:testnet': 154777,
    'LTC:testnet': 4905004,
    'DOGE:testnet': 67956922,
    regtest: 0,
});

// archive_match_count_activation
// Mainnet stays inert; the v0.21.3 cut arms testnet per chain. Moved here from
// gates_1.js when the testnet keys took that part file past its 400-line limit.
addGate('archive_match_count_activation.ARCHIVE_MATCH_COUNT_ACTIVATION', 'height', {
    mainnet: UNARMED,
    'BTC:testnet': 154971,
    'LTC:testnet': 4905844,
    'DOGE:testnet': 67961578,
    testnet: UNARMED,
    regtest: 0,
});
