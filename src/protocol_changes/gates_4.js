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
