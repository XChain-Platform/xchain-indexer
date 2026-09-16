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
 * Wire-field classification lists of src/config.js's getConfig():
 * NUMBER_FIELDS, INTEGER_FIELDS, LOCK_FIELDS and LIST_FIELDS.
 *
 * The literals are frozen templates at module scope and every getConfig()
 * call receives its own copies, exactly as when they were written inline, so
 * a consumer that mutates one config cannot leak into the next.
 ********************************************************************/

'use strict';

// Define list of NUMBER fields
const NUMBER_FIELDS = Object.freeze([
    'ALLOW_LIST',
    'AMOUNT',
    'BALANCES',
    'BLOCK_LIST',
    'BROADCAST_ACTION_INDEX',
    'CALLBACK_AMOUNT',
    'CALLBACK_BLOCK',
    'COIN1_ACTION_INDEX',
    'COIN2_ACTION_INDEX',
    // CONTRACT_ACTION_INDEX / TARGET_CONTRACT_INDEX: DEPOSIT/WITHDRAW/EXECUTE and
    // the contract-staking family write their row even when the action is invalid,
    // so a non-numeric wire value ('null', text) must normalize to NULL for storage.
    // Without this the BIGINT insert throws under STRICT_TRANS_TABLES and the
    // block-processing retry loop hard-wedges the indexer (found 2026-07-05 when a
    // broadcast DEPOSIT|0|null|... wedged the LTC-regtest venue).
    'CONTRACT_ACTION_INDEX',
    // CONTRACT_INDEX is the storage-side key createContractExecution /
    // createContractState read; the EXECUTE handler copies the (possibly junk)
    // wire CONTRACT_ACTION_INDEX into it for the row write, so it needs the
    // same numeric-or-NULL normalization.
    'CONTRACT_INDEX',
    'CONTROLLER',
    'COOLDOWN_BLOCKS',
    // DEADLINE / FEED_ACTION_INDEX / MIN_AMOUNT / OUTCOME / REFUND_WINDOW:
    // BET wire fields, numeric-or-NULL normalized for storage; MIN_AMOUNT
    // additionally in lockstep with the SDK NUMBER_FIELDS so both sides
    // canonicalize to fixed decimal (a raw "1e-8" minimum stake would
    // otherwise store verbatim)
    'DEADLINE',
    'DECIMALS',
    // DEPOSIT / GAS_ESCROW: VOTE v0 poll-creator escrow amounts. Kept in
    // lockstep with the SDK NUMBER_FIELDS so both sides canonicalize the
    // wire value to fixed decimal (a raw "1e-8" would otherwise be stored
    // verbatim in polls.deposit_amount / gas_escrow).
    'DEPOSIT',
    'DISPENSER_ACTION_INDEX',
    'EDIT',
    'ENCRYPTION_METHOD',
    'EXPIRATION',
    'FEE',
    'FEE_AMOUNT',
    'FEED_ACTION_INDEX',
    'FIAT_AMOUNT',
    'GAS_ESCROW',
    'GET_AMOUNT',
    'GIVE_AMOUNT',
    'GIVE_ESCROW',
    'LIST_ACTION_INDEX',
    'MAX_SUPPLY',
    'MAX_MINT',
    'MINT_ADDRESS_MAX',
    'MINT_START_BLOCK',
    'MINT_STOP_BLOCK',
    'MIN_AMOUNT',
    'MINT_SUPPLY',
    'ORDER_ACTION_INDEX',
    'OUTCOME',
    'OWNERSHIPS',
    'REFUND_WINDOW',
    'RESUME_BLOCK',
    'SWAP_ACTION_INDEX',
    'TARGET_CONTRACT_INDEX',
    'TYPE',
    'UNBIND',
    'VALUE',
]);

// Wire fields that land in an INTEGER database column, mapped to the largest value
// that column can hold. NUMBER_FIELDS normalizes a field to numeric-or-NULL but puts
// no bound on MAGNITUDE, so a wire value such as EXPIRATION='18446744073709551616'
// clears every format check and reaches a BIGINT UNSIGNED bind: under
// STRICT_TRANS_TABLES that throws inside the block transaction and the retry loop
// re-runs the same deterministic transaction forever (the same wedge shape recorded
// for CONTRACT_ACTION_INDEX above), and under a permissive sql_mode it clamps, which
// stores a different value on different nodes. normalizeDataValues nulls anything
// outside [0, max] for these fields.
//
// AMOUNT-style fields are deliberately absent: give_amount, get_amount, MAX_SUPPLY,
// MIN_AMOUNT, FEE and friends are VARCHAR(250) columns carrying fixed-decimal
// strings, and range-clamping them would destroy real balances.
//
// The bound is representability only. It does NOT narrow the accepted range to
// Number.MAX_SAFE_INTEGER: values between 2^53 and 2^64-1 are accepted and stored
// exactly today, and narrowing them is a consensus rule change that has to ride the
// per-network activation registry in src/protocol_changes.js.
const U64_MAX = '18446744073709551615';   // BIGINT UNSIGNED
const U32_MAX = '4294967295';             // INT UNSIGNED
const INTEGER_FIELDS = Object.freeze({
    'ALLOW_LIST':               U64_MAX,
    'BLOCK_LIST':               U64_MAX,
    'BROADCAST_ACTION_INDEX':   U64_MAX,
    'CALLBACK_BLOCK':           U64_MAX,
    'COIN1_ACTION_INDEX':       U64_MAX,
    'COIN2_ACTION_INDEX':       U64_MAX,
    'CONTRACT_ACTION_INDEX':    U64_MAX,
    'CONTRACT_INDEX':           U64_MAX,
    'COOLDOWN_BLOCKS':          U32_MAX,
    'DEADLINE':                 U64_MAX,
    'DISPENSER_ACTION_INDEX':   U64_MAX,
    'EXPIRATION':               U64_MAX,
    'FEED_ACTION_INDEX':        U64_MAX,
    'LIST_ACTION_INDEX':        U64_MAX,
    // MINT_START_BLOCK / MINT_STOP_BLOCK also reach a VARCHAR(15) mirror column on
    // one table, which a 20-digit value still overflows; the u64 bound closes the
    // integer-column exposure and that narrower one stays open.
    'MINT_START_BLOCK':         U64_MAX,
    'MINT_STOP_BLOCK':          U64_MAX,
    'ORDER_ACTION_INDEX':       U64_MAX,
    'OUTCOME':                  U32_MAX,
    'REFUND_WINDOW':            U64_MAX,
    'SWAP_ACTION_INDEX':        U64_MAX,
    'TARGET_CONTRACT_INDEX':    U64_MAX
});

// Define list of LOCK fields
const LOCK_FIELDS = Object.freeze([
    'LOCK_MAX_SUPPLY',
    'LOCK_MINT',
    'LOCK_MINT_SUPPLY',
    'LOCK_MAX_MINT',
    'LOCK_DESCRIPTION',
    'LOCK_SLEEP',
    'LOCK_CALLBACK'
]);

// Define list of LIST fields
const LIST_FIELDS = Object.freeze([
    'ALLOW_LIST',
    'BLOCK_LIST'
]);

// Copy each template onto the config in the key order getConfig() has always used.
function applyWireFields(config){
    config['NUMBER_FIELDS']  = NUMBER_FIELDS.slice();
    config['INTEGER_FIELDS'] = Object.assign({}, INTEGER_FIELDS);
    config['LOCK_FIELDS']    = LOCK_FIELDS.slice();
    config['LIST_FIELDS']    = LIST_FIELDS.slice();
}

module.exports = { applyWireFields };
