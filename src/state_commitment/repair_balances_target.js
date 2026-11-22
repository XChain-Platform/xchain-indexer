/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 ********************************************************************/

'use strict';

const { RESERVED_SUBTREES } = require('../consensus/gates/state_subtree_gate.js');

// Every reserved sub-root the stored row carries a value for, or null for a v1 row.
function storedExtras(row){
    const extras = {};
    for(const name of RESERVED_SUBTREES)
        if(row[name] != null) extras[name] = String(row[name]);
    return Object.keys(extras).length === 0 ? null : extras;
}

// The caller reassembles the committed row from its own stored parts and hands the
// result in: state roots are assembled only through the orchestrator module, so this
// file compares and never assembles.
function committedRowError(row, reassembled){
    const stored = String(row.state_root);
    if(reassembled === stored) return null;
    return 'committed state_root at ' + row.block_index +
        ' does not reassemble from its own stored sub-roots (' + reassembled + ' != ' + stored + ')';
}

function requestedTipError(requested, actual){
    if(requested == null || Number(requested) === Number(actual)) return null;
    return 'repair only operates at the current tip ' + actual + '; --block ' + requested +
        (Number(requested) < Number(actual) ? ' is below it' : ' is above it');
}

function sameStoredValue(a, b){
    if(a == null || b == null) return a == null && b == null;
    return String(a) === String(b);
}

function tipUnchanged(before, after){
    if(!before || !after || Number(before.block_index) !== Number(after.block_index)) return false;
    if(!sameStoredValue(before.balances_root, after.balances_root)) return false;
    if(!sameStoredValue(before.stakes_root, after.stakes_root)) return false;
    if(!sameStoredValue(before.state_root, after.state_root)) return false;
    return RESERVED_SUBTREES.every(name => sameStoredValue(before[name], after[name]));
}

module.exports = { storedExtras, committedRowError, requestedTipError, tipUnchanged };
