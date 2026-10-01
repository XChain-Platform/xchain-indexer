'use strict';

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
 *********************************************************************/

const { listMembershipHash } = require('../list_share_hash.js');
const { LIST_SHARE_HALT_REASON } = require('./halt.js');

function compareMembers(a, b){
    return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function isCanonicalOrder(members){
    if(!Array.isArray(members) || members.some(member => typeof member !== 'string'))
        return false;
    for(let i = 1; i < members.length; i++){
        if(compareMembers(members[i - 1], members[i]) >= 0)
            return false;
    }
    return true;
}

function applyDelta(current, added, removed){
    if(!Array.isArray(current) || !isCanonicalOrder(added) || !isCanonicalOrder(removed))
        return null;

    const present = new Set(current);
    const additions = new Set(added);
    if(added.some(member => present.has(member)) ||
        removed.some(member => !present.has(member) || additions.has(member)))
        return null;

    for(const member of removed) present.delete(member);
    for(const member of added) present.add(member);
    return [...present].sort(compareMembers);
}

function nextMembership(current, row){
    let membership;
    if(row.seq === 1 || row.seq === '1' || row.seq === 1n){
        if(current !== null || !Array.isArray(row.added))
            return { halt: LIST_SHARE_HALT_REASON.DELTA };
        membership = row.added.slice();
    } else {
        membership = applyDelta(current, row.added, row.removed);
        if(membership === null)
            return { halt: LIST_SHARE_HALT_REASON.DELTA };
    }

    if(listMembershipHash(membership) !== row.members_hash)
        return { halt: LIST_SHARE_HALT_REASON.MEMBERS_HASH };
    return { membership };
}

module.exports = { nextMembership };
