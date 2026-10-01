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
 * XChain Platform - list share settlement recording.
 *
 ********************************************************************/

'use strict';

const { recordSettlement } = require('../bridge_settle/settlements.js');

async function recordListShareApplied(db, {
    actionIndexes,
    snapshotId,
    homeChain,
    homeListIndex,
    coin,
    blockIndex,
}){
    if(!Array.isArray(actionIndexes) ||
       !/^[0-9a-f]{64}$/.test(snapshotId) ||
       typeof homeChain !== 'string' || homeChain.length === 0 ||
       typeof coin !== 'string' || coin.length === 0){
        throw new TypeError('Invalid list share settlement record');
    }

    const anchor = actionIndexes.length > 0
        ? Number(actionIndexes[actionIndexes.length - 1])
        : await db.createActionIndex({ ACTION: 'LIST_SHARE', BLOCK_INDEX: blockIndex, FORMAT: 0 });

    await recordSettlement(db, anchor, snapshotId, 'list', blockIndex, {
        src_chain: homeChain,
        src_action_index: homeListIndex,
        dest_chain: coin,
        dest_address: null,
        tick: null,
    });

    return anchor;
}

module.exports = { recordListShareApplied };
