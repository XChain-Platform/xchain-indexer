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
 * XChain Platform - bridge settle pass: the due-set trim for by-reference policy snapshots.
 *
 * A snapshot that carries a list reference cannot apply until the reference resolves, and a
 * later policy_seq of the same (origin_chain, tick) must not overtake it. Pure: no database,
 * gate or activation read; the caller supplies the predicate that says what a reference is.
 *
 ********************************************************************/

'use strict';

function groupKey(row){
    return JSON.stringify([row.origin_chain, row.tick]);
}

// Returns a new array holding `rows` in their given order, without every row of a group whose
// policy_seq is at or above the lowest policy_seq among the group's rows carrying a reference.
// A group with no such row is untouched. The input is never mutated.
function dropRefRowsFromFirst(rows, carriesRef){
    if(!Array.isArray(rows)) throw new TypeError('rows must be an array');
    if(typeof carriesRef !== 'function') throw new TypeError('carriesRef must be a function');

    const firstRef = new Map();
    for(const row of rows){
        if(!carriesRef(row)) continue;
        const key = groupKey(row);
        const seq = Number(row.policy_seq);
        const cur = firstRef.get(key);
        if(cur === undefined || seq < cur) firstRef.set(key, seq);
    }
    if(firstRef.size === 0) return rows.slice();

    return rows.filter((row) => {
        const cut = firstRef.get(groupKey(row));
        return cut === undefined || Number(row.policy_seq) < cut;
    });
}

module.exports = { dropRefRowsFromFirst };
