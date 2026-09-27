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
    'BTC:testnet': UNARMED,
    'LTC:testnet': UNARMED,
    'DOGE:testnet': UNARMED,
    testnet: UNARMED,
    regtest: 0,
});

// dispenser_settlement_price_activation: against data['BLOCK_TIME']. A FIAT create or refill
// needs the price a DISPENSE at that block would settle against (Mode A snapshot, Mode B pair).
addGate('dispenser_settlement_price_activation.DISPENSER_SETTLEMENT_PRICE_ACTIVATION', 'time', {
    mainnet: UNARMED,       // UNARMED (house sentinel) until a release names the instant
    'BTC:testnet': UNARMED,
    'LTC:testnet': UNARMED,
    'DOGE:testnet': UNARMED,
    testnet: UNARMED,       // UNARMED: testnet carries live FIAT creates this would re-judge
    regtest: 0,
});

// empty_allow_list_denies_activation
// At or above this height an attached ALLOW_LIST that resolves to no members
// denies every address in ORDER_MATCH, SWAP_MATCH and CALLBACK. Below it those
// consumers retain their legacy empty-list fail-open behavior.
addGate('empty_allow_list_denies_activation.EMPTY_ALLOW_LIST_DENIES', 'height', {
    mainnet: UNARMED,
    'BTC:testnet': UNARMED,
    'LTC:testnet': UNARMED,
    'DOGE:testnet': UNARMED,
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
    'BTC:testnet': UNARMED,
    'LTC:testnet': UNARMED,
    'DOGE:testnet': UNARMED,
    testnet: UNARMED,
    regtest: 0,
});

// token_gate_list_at_block
// At or above this height address-plus-token policy checks resolve token state and
// LIST membership at the action's block. Below it they retain the unbounded
// legacy lookup so historical replay remains byte-identical.
addGate('token_gate_list_at_block.TOKEN_GATE_LIST_AT_BLOCK', 'height', {
    mainnet: UNARMED,
    'BTC:testnet': UNARMED,
    'LTC:testnet': UNARMED,
    'DOGE:testnet': UNARMED,
    testnet: UNARMED,
    regtest: 0,
});

// order_swap_maker_policy_admission
// At or above this height a local ORDER or SWAP maker's GET_ADDRESS must pass
// both token policies before the GIVE side enters escrow.
addGate('order_swap_maker_policy_admission.ORDER_SWAP_MAKER_POLICY_ADMISSION', 'height', {
    mainnet: UNARMED,
    'BTC:testnet': UNARMED,
    'LTC:testnet': UNARMED,
    'DOGE:testnet': UNARMED,
    testnet: UNARMED,
    regtest: 0,
});

// list_reference_validity_activation
// Require referenced LIST actions to carry a valid verdict. Below activation,
// reference validation accepts any stored LIST row of the right type. An invalid
// stored reference counts as no list for policy consumers after activation.
addGate('list_reference_validity_activation.LIST_REFERENCE_REQUIRES_VALID_LIST', 'height', {
    mainnet: UNARMED,
    'BTC:testnet': UNARMED,
    'LTC:testnet': UNARMED,
    'DOGE:testnet': UNARMED,
    testnet: UNARMED,
    regtest: 0,
});

// list_head_follows_edit_chain
// At or above this height, LIST head resolution follows legacy edits that
// reference another edit instead of only considering direct children of CREATE.
addGate('list_head_follows_edit_chain.LIST_HEAD_FOLLOWS_EDIT_CHAIN', 'height', {
    mainnet: UNARMED,
    'BTC:testnet': UNARMED,
    'LTC:testnet': UNARMED,
    'DOGE:testnet': UNARMED,
    testnet: UNARMED,
    regtest: 0,
});

// callback_compensation_activation
// Reject a CALLBACK when a holder of the recalled TICK cannot receive the
// CALLBACK_TICK compensation. Below this height legacy settlement is retained.
addGate('callback_compensation_activation.CALLBACK_COMPENSATES_EVERY_DEBITED_HOLDER', 'height', {
    mainnet: UNARMED,
    'BTC:testnet': UNARMED,
    'LTC:testnet': UNARMED,
    'DOGE:testnet': UNARMED,
    testnet: UNARMED,
    regtest: 0,
});

// vote_callback_binding_activation
// Require a VOTE binding callback to target a currently active contract and a
// callable export. Below this height creation checks only contract existence.
addGate('vote_callback_binding_activation.VOTE_CALLBACK_BINDING_REQUIRES_USABLE_METHOD', 'height', {
    mainnet: UNARMED,
    'BTC:testnet': UNARMED,
    'LTC:testnet': UNARMED,
    'DOGE:testnet': UNARMED,
    testnet: UNARMED,
    regtest: 0,
});

// order_swap_payout_policy_activation
// At or above this height, each ORDER or SWAP payout address is checked only
// against the generic policy of the token delivered to it.
addGate('order_swap_payout_policy_activation.ORDER_SWAP_PAYOUT_POLICY_PER_TOKEN', 'height', {
    mainnet: UNARMED,
    'BTC:testnet': UNARMED,
    'LTC:testnet': UNARMED,
    'DOGE:testnet': UNARMED,
    testnet: UNARMED,
    regtest: 0,
});

// issue_policy_list_detach
// At or above this height an ISSUE format 5 may carry `0` in ALLOW_LIST or
// BLOCK_LIST to detach that policy list. Empty fields inherit current ids.
addGate('issue_policy_list_detach.ISSUE_POLICY_LIST_DETACH', 'height', {
    mainnet: UNARMED,
    'BTC:testnet': UNARMED,
    'LTC:testnet': UNARMED,
    'DOGE:testnet': UNARMED,
    testnet: UNARMED,
    regtest: 0,
});

// bridge_policy_detach_activation
// Read by the bridge policy settle pass at the destination chain's own block index.
// At or above it a signed snapshot whose allow or block list is null detaches the bridged copy's matching list; below it a null list leaves the copy's list attached (byte-identical replay).
// It must never arm ahead of issue_policy_list_detach.ISSUE_POLICY_LIST_DETACH, whose `0` sentinel it injects.
addGate('bridge_policy_detach_activation.BRIDGE_POLICY_DETACH', 'height', {
    mainnet: UNARMED,
    'BTC:testnet': UNARMED,
    'LTC:testnet': UNARMED,
    'DOGE:testnet': UNARMED,
    testnet: UNARMED,
    regtest: 0,
});
