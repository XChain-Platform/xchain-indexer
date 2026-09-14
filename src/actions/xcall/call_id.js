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
 * XCALL call_id preimage declaration and mismatch diagnostics.
 *
 * Split out of the handler entry so the request phase (request.js) and the
 * entry's re-exports read the SAME declaration: the field order and the status
 * budget are consensus-visible, and a second copy beside the first is how a
 * preimage skew gets introduced without either copy looking wrong.
 * actions/xcall/index.js re-exports all four names, so every existing consumer
 * (Xcall.CALL_ID_PREIMAGE_FIELDS, bin/check-preimage-golden-parity.js) is
 * unchanged.
 *
 ********************************************************************/

'use strict';

// call_id preimage fields, in preimage order. This list is the single in-file
// source of truth for the ORDER and the COUNT, so a skew against the VM's
// derivation is one visible edit rather than a miscounted string concatenation.
// Exported and pinned against the canonical
// xchain-vm GOLDEN_VECTORS.callId tuple by bin/check-preimage-golden-parity.js.
const CALL_ID_PREIMAGE_FIELDS = [
    'NETWORK', 'COIN', 'TX_HASH', 'ROOT_ACTION_INDEX',
    'CONTRACT_INDEX', 'EMITTER_PATH', 'EMITTER_POSITION', 'TARGET_CHAIN'
];

// Leading text of the call_id mismatch status. Kept as a stable prefix so the
// diagnostic tail below can be extended without breaking status matching.
const CALL_ID_MISMATCH_ERROR = 'invalid: CALL_ID (does not match deterministic derivation)';

// index_statuses.status is VARCHAR(250); an over-long status is cut by MariaDB at
// a length that varies with sql_mode, so the tail is budgeted here instead.
const STATUS_MAX_LENGTH = 250;

// Diagnostic tail for a call_id mismatch. The bare error cannot tell a forged
// call_id from a VM/indexer preimage skew, which is the failure the operator
// actually needs to distinguish, so the field count, both hash heads and the
// preimage itself are recorded. Deterministic on every node (all inputs are
// chain data or node-uniform config) and budget-capped, never DB-truncated.
function callIdMismatchStatus(values, expected, supplied){
    const head16 = (h) => String(h == null ? '' : h).toLowerCase().substring(0, 16);
    const open   = ' [fields=' + values.length +
                   ' expected=' + head16(expected) +
                   ' got='      + head16(supplied) +
                   ' preimage=';
    const budget   = STATUS_MAX_LENGTH - CALL_ID_MISMATCH_ERROR.length - open.length - 1;
    const preimage = values.join(':');
    const shown    = preimage.length <= budget ? preimage : preimage.substring(0, budget - 1) + '~';
    return CALL_ID_MISMATCH_ERROR + open + shown + ']';
}

module.exports = { CALL_ID_PREIMAGE_FIELDS, CALL_ID_MISMATCH_ERROR, STATUS_MAX_LENGTH, callIdMismatchStatus };
