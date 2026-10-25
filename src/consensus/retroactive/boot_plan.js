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
 **********************************************************************
 *
 * Chooses the boot action for retroactive replay without performing I/O.
 *
 *********************************************************************/

'use strict';

function assertHeight(value, name){
    if(!Number.isSafeInteger(value) || value < 0)
        throw new TypeError(`${name} must be a non-negative safe integer`);
}

function planRetroactiveBoot({
    openMarker,
    refusedKeys,
    target,
    tip,
    capBlocks,
    goMatches,
    mirrorGap
}){
    if(openMarker && (openMarker.state === 'pending' || openMarker.state === 'replaying')){
        return {
            action: 'resume',
            target: openMarker.target,
            stallReason: 'retroactive_replay'
        };
    }

    assertHeight(tip, 'tip');
    assertHeight(capBlocks, 'capBlocks');
    if(target !== null) assertHeight(target, 'target');
    if(target !== null && target > tip) throw new RangeError('target must not exceed tip');

    if(refusedKeys.length > 0){
        return {
            action: 'refuse',
            reason: 'non_movable',
            keys: [...refusedKeys].sort()
        };
    }

    if(target === null) return { action: 'serve' };

    const distance = tip - target + 1;

    if(distance > capBlocks && goMatches !== true){
        return {
            action: 'refuse',
            reason: 'needs_go',
            stallReason: 'retroactive_replay_needs_go',
            target,
            distance
        };
    }

    if(typeof mirrorGap === 'string' && mirrorGap.length > 0){
        return {
            action: 'refuse',
            reason: 'mirror_gap',
            detail: mirrorGap
        };
    }

    return {
        action: 'rollback',
        target,
        distance,
        stallReason: 'retroactive_replay'
    };
}

module.exports = { planRetroactiveBoot };
