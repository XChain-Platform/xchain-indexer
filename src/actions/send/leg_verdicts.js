/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 * XChain Platform Action - SEND: probe leg verdict folding
 *
 ********************************************************************/

'use strict';

function foldLegVerdicts(legs, isGuardInert){
    if(!Array.isArray(legs) || legs.length === 0) return null;
    let copied = legs.map((leg) => Object.assign({}, leg));
    let refused = copied.find((leg) => leg.status !== 'valid' && !isGuardInert(leg.status));
    if(!refused) refused = copied.find((leg) => leg.status !== 'valid');
    return { status: refused ? refused.status : 'valid', legs: copied };
}

module.exports = { foldLegVerdicts };
