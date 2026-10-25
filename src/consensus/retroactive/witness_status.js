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
 * Pure status rules for a retroactive replay witness.
 *
 *********************************************************************/

'use strict';

function witnessFromPhase(phase) {
    if(phase === null || phase === undefined) return null;

    switch(phase){
        case 'witness': return 'running';
        case 'witnessed':
        case 'final': return 'passed';
        case 'diverged': return 'diverged';
        default: throw new TypeError('invalid retroactive replay phase');
    }
}

function statusRulesDigest(mapDigest, marker, phase) {
    if(phase === 'witness' && marker &&
        (marker.state === 'pending' || marker.state === 'replaying'))
        return marker.rules_to;
    return mapDigest;
}

module.exports = { witnessFromPhase, statusRulesDigest };
