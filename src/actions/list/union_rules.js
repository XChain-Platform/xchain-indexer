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
 ********************************************************************/

function canonicalMemberIndex(item){
    return typeof item === 'string' && /^[1-9][0-9]*$/.test(item) ? item : null;
}

function unionResultVerdict({ isCreate, memberCount, mergedCount }, { unionMax, shareMax }){
    if(isCreate && memberCount === 0)
        return 'invalid: ITEM (no member list)';
    if(memberCount > unionMax)
        return 'invalid: ITEM (union exceeds LIST_UNION_MAX_MEMBERS)';
    if(mergedCount > shareMax)
        return 'invalid: ITEM (union exceeds LIST_SHARE_MAX_MEMBERS)';
    return null;
}

function memberTypeVerdict(memberType, unionMemberType){
    return memberType === unionMemberType ? null : 'invalid: LIST (type)';
}

function storedTypeVerdict(storedType){
    return storedType === 3 ? 'invalid: LIST (union)' : null;
}

module.exports = {
    canonicalMemberIndex,
    unionResultVerdict,
    memberTypeVerdict,
    storedTypeVerdict,
};
