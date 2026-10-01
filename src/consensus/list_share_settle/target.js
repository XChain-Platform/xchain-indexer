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

'use strict';

const { ListShareHaltError, LIST_SHARE_HALT_REASON } = require('./halt.js');

function compareMembers(left, right){
    return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

async function listShareTarget(db, { row, config, blockIndex }){
    const ownerKey = 'BRIDGE_' + row.home_chain;
    const owner = config.ADDRESS && config.ADDRESS[ownerKey];
    if(!owner)
        throw new ListShareHaltError(
            LIST_SHARE_HALT_REASON.NO_OWNER,
            row.snapshot_id,
            ownerKey
        );

    const mirror = await db.getListShareMirror(row.home_chain, row.home_list_index) || null;
    if(mirror === null)
        return { owner, mirror, current: null };

    const members = await db.getList(Number(mirror.action_index), blockIndex);
    const current = Array.isArray(members) ? members.map(String).sort(compareMembers) : null;
    return { owner, mirror, current };
}

module.exports = { listShareTarget };
