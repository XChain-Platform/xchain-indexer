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
 * XChain Platform - list share mirror membership verification.
 *
 ********************************************************************/

'use strict';

const { listMembershipHash } = require('../list_share_hash.js');
const { ListShareHaltError, LIST_SHARE_HALT_REASON } = require('./halt.js');

function isMirrorIndex(value){
    if(typeof value === 'number')
        return Number.isSafeInteger(value) && value > 0;
    return typeof value === 'string' && /^[1-9]\d*$/.test(value) &&
        Number.isSafeInteger(Number(value));
}

function compareMembers(a, b){
    return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

async function verifyMirrorMembers(db, {
    mirrorIndex,
    blockIndex,
    membersHash,
    snapshotId,
}){
    if(!isMirrorIndex(mirrorIndex))
        throw new TypeError('mirrorIndex must be a positive safe integer');
    if(typeof membersHash !== 'string' || !/^[0-9a-f]{64}$/.test(membersHash))
        throw new TypeError('membersHash must be 64 lowercase hexadecimal characters');

    const answer = await db.getList(Number(mirrorIndex), blockIndex);
    if(!Array.isArray(answer)){
        throw new ListShareHaltError(
            LIST_SHARE_HALT_REASON.MEMBERS_HASH,
            snapshotId,
            'mirror ' + mirrorIndex + ' unreadable'
        );
    }

    const members = Array.from(answer, member => String(member)).sort(compareMembers);
    if(listMembershipHash(members) !== membersHash){
        throw new ListShareHaltError(
            LIST_SHARE_HALT_REASON.MEMBERS_HASH,
            snapshotId,
            'mirror ' + mirrorIndex
        );
    }
    return members;
}

module.exports = { verifyMirrorMembers };
