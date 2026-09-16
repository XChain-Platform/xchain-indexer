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
 * XChain Platform - bridge settle pass: the token-policy membership transport rules.
 *
 * The policy hash, the canonical-order guard and the transport parser. All three are pure
 * functions of their arguments and read no activation, so this part is required directly.
 *
 ********************************************************************/

'use strict';

const { sha256 } = require('./reasons.js');

/**
 * Recompute policy_hash from the TRANSPORT membership arrays, exactly as the hub built it:
 *
 *   ALLOW|<n or ->|<addr>|...|BLOCK|<m or ->|<addr>|...|SLEEP|<0 or 1>
 *
 * `-` means the origin row has no such list at all; `0` means it has an EMPTY one, and the
 * two are not the same thing (an empty allow list is deny-everyone under
 * isActionAllowed, while an absent one is no gate at all).
 *
 * THE ARRAYS ARE HASHED AS GIVEN, never re-sorted. Sorting first would make an out-of-order
 * transport array hash to the signed value, which is precisely the property that lets
 * verifyMembershipOrder below be a real guard instead of decoration.
 *
 * @param {Array<string>|null} allow
 * @param {Array<string>|null} block
 * @param {boolean} sleeping
 * @returns {string} lowercase sha256 hex
 */
function policyHash(allow, block, sleeping){
    const part = (label, list) => {
        if(list === null || list === undefined) return [label, '-'];
        return [label, String(list.length)].concat(list.map(String));
    };
    const text = part('ALLOW', allow)
        .concat(part('BLOCK', block))
        .concat(['SLEEP', sleeping ? '1' : '0'])
        .join('|');
    return sha256(text);
}

/**
 * True when a membership array is already in the canonical order the hub built the hash over:
 * `utf8_bin`, i.e. plain byte order, the order db.getList returns for a type-2 address list.
 *
 * Byte order and NOT JavaScript's default string comparison: the default compares UTF-16 code
 * units, which orders a supplementary-plane character before a BMP character above U+E000 and
 * would accept an array the hub would have ordered the other way. Addresses are ASCII today,
 * so the two agree today; the guard is written against the rule rather than against today's
 * data, because the day they disagree is the day a legitimate snapshot is refused fleet-wide.
 *
 * @param {Array<string>|null} list
 * @returns {boolean} true for null and for a list of fewer than two items
 */
function verifyMembershipOrder(list){
    if(list === null || list === undefined) return true;
    if(!Array.isArray(list)) return false;
    for(let i = 1; i < list.length; i++){
        const prev = Buffer.from(String(list[i - 1]), 'utf8');
        const cur  = Buffer.from(String(list[i]),     'utf8');
        if(Buffer.compare(prev, cur) > 0) return false;
    }
    return true;
}

/**
 * Parse a transport membership column: a JSON array, or null when the origin row holds no such
 * list. A malformed value is NOT read as an empty list, because empty and absent mean opposite
 * things under isActionAllowed; it returns the `bad` sentinel so the caller refuses the row.
 *
 * @param {*} value
 * @returns {Array<string>|null|false} false means malformed
 */
function parseMembership(value){
    if(value === null || value === undefined) return null;
    if(Array.isArray(value)) return value.map(String);
    let parsed;
    try { parsed = JSON.parse(String(value)); } catch(e){ return false; }
    if(parsed === null) return null;
    if(!Array.isArray(parsed)) return false;
    return parsed.map(String);
}

module.exports = { policyHash, verifyMembershipOrder, parseMembership };
