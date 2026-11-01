/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC, https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available; contact
 * legal@dankest.llc.
 *
 **********************************************************************
 *
 * Pure boot planning for a retroactive replay witness phase.
 *
 *********************************************************************/

'use strict';

function planWitnessPhase({ phase, tip, target }) {
    if(!Number.isSafeInteger(target) || target < 0)
        throw new TypeError('target must be a non-negative safe integer');

    const reachedTarget = tip !== null && tip >= target;

    switch(phase){
        case 'witness':
            return {
                rollback: reachedTarget,
                overlay: true,
                writePhase: null,
                stallReason: null,
            };
        case 'witnessed':
            return {
                rollback: reachedTarget,
                overlay: false,
                writePhase: 'final',
                stallReason: null,
            };
        case 'final':
        case null:
        case undefined:
            return {
                rollback: false,
                overlay: false,
                writePhase: null,
                stallReason: null,
            };
        case 'diverged':
            return {
                rollback: false,
                overlay: false,
                writePhase: null,
                stallReason: 'retroactive_replay_diverged',
            };
        default:
            throw new TypeError('invalid retroactive replay witness phase');
    }
}

module.exports = { planWitnessPhase };
