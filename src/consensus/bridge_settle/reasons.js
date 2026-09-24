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
 * XChain Platform - bridge settle pass: the refusal vocabulary, the pinned wire constants
 * and the field coercions every other part of the pass shares.
 *
 * Nothing here holds state or reads an activation, so this part is required directly by the
 * entry and by every sibling part rather than being built by the entry (see the entry's
 * header for why the activation-reading parts are built instead of required).
 *
 ********************************************************************/

'use strict';

const crypto = require('crypto');

// Why a row did not apply. LOG reasons, never consensus verdict strings: an injected settle
// leg writes no STATUS (actions/xbridge/index.js returns a system-injected v2/v5 untouched, so the
// settle pass is the only writer of that row) and no canonical carries any of these. The
// boolean beside them is the consensus-visible part.
const SETTLE_REASON = {
    NOT_OURS:        'this chain is not the destination leg of the transfer',
    ROW_FIELDS:      'transfer row is missing fields the apply needs',
    NETWORK:         'row network does not match this indexer',
    CHAIN_ID:        'row btc_chain_id does not match this chain identity',
    NOT_FINALIZED:   'row is not finalized',
    NOT_DUE:         'effective_time is ahead of this block protocol time',
    ALREADY_APPLIED: 'already recorded in bridge_settlements',
    SRC_LEG_APPLIED: 'this chain already applied a settlement for the source leg',
    QUORUM:          'insufficient cross_chain quorum over the signed canonical',
    SNAPSHOT_ABSENT: 'capability snapshot for snapshot_block is not mirrored yet',
    ESCROW_PROOF:    'escrow cross-check refused the row',
    ESCROW_MISSING:  'no escrow role address is configured for the source chain',
    ESCROW_SHORT:    'escrow balance would go negative',
    TOKEN_ROW:       'the bridged token row could not be created',
    AMOUNT:          'amount is not a positive decimal at the signed decimals',
    // Policy-only
    POLICY_HASH:     'recomputed policy_hash does not match the signed hash',
    POLICY_ORDER:    'membership array is not in canonical order',
    POLICY_ORIGIN:   'this chain is the origin of the policy, nothing to inherit',
    POLICY_NO_COPY:  'no bridged copy of the tick exists on this chain yet',
    POLICY_SEQ_GAP:  'an earlier policy_seq for this tick is finalized and not applied yet',
    POLICY_LEG:      'an injected policy leg did not apply',
};

// The injected policy legs, ordinal per leg. CONSENSUS-VISIBLE and pinned for every node
// forever: the ordinal is the synthetic transaction's vout, so it decides the action index
// each leg takes, and a reordering here would give two nodes different action indexes for the
// same snapshot. Legs with nothing to do are not injected, which is why the ordinal is fixed
// per LEG rather than assigned by counting the legs that ran.
const POLICY_LEG_ORDINAL = {
    ALLOW_CREATE_OR_REMOVE: 0,
    ALLOW_ADD:              1,
    BLOCK_CREATE_OR_REMOVE: 2,
    BLOCK_ADD:              3,
    ISSUE_POINT:            4,
    SLEEP:                  5,
};

// LIST wire constants (actions/list.js): type 2 is an ADDRESS list, edit 1 is ADD and 2 is
// REMOVE. Named here so the injected wire strings read as the protocol rather than as magic.
const LIST_TYPE_ADDRESS = '2';
const LIST_EDIT_ADD     = '1';
const LIST_EDIT_REMOVE  = '2';

// Synthetic transaction hash prefixes. They separate the injected families so one pass's hash
// can never collide with another's: 'GENESIS-' is genesis.js's, 'XPOLICY-' is the policy
// pass's and 'XBRIDGE-' is this pass's token-row creation. The policy prefix plus 48
// characters of the snapshot id is 56 characters, inside the 64-character unique prefix of
// index_transactions.hash.
const POLICY_TX_PREFIX = 'XPOLICY-';
const BRIDGE_TX_PREFIX = 'XBRIDGE-';

function isNull(v){ return v === null || v === undefined || v === ''; }

// A finite non-negative integer, or null. Heights, ordinals and action indexes arrive from a
// MariaDB driver that may hand back a number, a string or a BigInt depending on its bigint
// options, so the conversion is pinned here rather than trusted from the call site.
function int(v){
    if(v === null || v === undefined) return null;
    if(typeof v === 'bigint') return (v >= 0n && v <= BigInt(Number.MAX_SAFE_INTEGER)) ? Number(v) : null;
    const n = Number(v);
    return (Number.isFinite(n) && Number.isInteger(n) && n >= 0) ? n : null;
}

function sha256(s){ return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex'); }

module.exports = {
    SETTLE_REASON,
    POLICY_LEG_ORDINAL,
    LIST_TYPE_ADDRESS,
    LIST_EDIT_ADD,
    LIST_EDIT_REMOVE,
    POLICY_TX_PREFIX,
    BRIDGE_TX_PREFIX,
    isNull,
    int,
    sha256,
};
