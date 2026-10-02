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
 * XChain Platform - list share settle leg injection.
 *
 ********************************************************************/

'use strict';

const { listShareLegTx } = require('./legs.js');
const { ListShareHaltError, LIST_SHARE_HALT_REASON } = require('./halt.js');

async function injectListShareLegs(ctx, {
    legs,
    snapshotId,
    owner,
    homeChain,
    homeListIndex,
}){
    if(!Array.isArray(legs)) throw new TypeError('legs must be an array');
    if(typeof snapshotId !== 'string' || !/^[0-9a-f]{64}$/.test(snapshotId))
        throw new TypeError('snapshotId must be 64 lowercase hex characters');
    if(typeof owner !== 'string' || owner.length === 0)
        throw new TypeError('owner must be a non-empty string');

    const actionIndexes = [];
    let mirrorIndex = null;

    for(const leg of legs){
        const tx = listShareLegTx(leg, {
            snapshotId,
            owner,
            blockIndex: ctx.blockIndex,
            blockTime: ctx.blockTime,
        });
        const answer = await ctx.actions.processTransaction(tx, true);
        if(!answer || answer.STATUS !== 'valid'){
            throw new ListShareHaltError(
                LIST_SHARE_HALT_REASON.LEG,
                snapshotId,
                'ordinal ' + leg.ordinal
            );
        }

        const actionIndex = Number(answer.ACTION_INDEX);
        actionIndexes.push(actionIndex);

        if(leg.fields[1] === '0' || leg.fields[1] === '4'){
            mirrorIndex = actionIndex;
            await ctx.indexerDb.createListShareMirror({
                action_index: actionIndex,
                home_chain: homeChain,
                home_list_index: homeListIndex,
                block_index: ctx.blockIndex,
            });
        }
    }

    return { actionIndexes, mirrorIndex };
}

module.exports = { injectListShareLegs };
