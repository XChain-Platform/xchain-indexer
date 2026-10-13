/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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

const NETWORK = 'mainnet';

function isNonEmptyString(value){
    return typeof value === 'string' && value.length > 0;
}

// True only when seedSources holds, as an own property keyed coin:mainnet,
// an array containing source by exact string equality. Anything malformed
// fails closed with false.
function isPrelaunchSeedSource(source, coin, seedSources){
    if(!isNonEmptyString(source) || !isNonEmptyString(coin)){
        return false;
    }
    if(seedSources === null || typeof seedSources !== 'object'){
        return false;
    }
    const key = coin + ':' + NETWORK;
    if(!Object.prototype.hasOwnProperty.call(seedSources, key)){
        return false;
    }
    const pinned = seedSources[key];
    return Array.isArray(pinned) && pinned.includes(source);
}

module.exports = { isPrelaunchSeedSource };
