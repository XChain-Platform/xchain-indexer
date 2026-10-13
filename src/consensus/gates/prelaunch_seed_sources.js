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

// Exports isPrelaunchSeedSource (pinned seed source test) and admitsPrelaunch,
// which composes it with isValidatorWireAction from validator_wire_actions.js
// into the full prelaunch admission decision.

const { isValidatorWireAction } = require('./validator_wire_actions');

const NETWORK = 'mainnet';
const OPEN_NETWORKS = ['testnet', 'regtest'];

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

// True when the input may be admitted before or after launch. Only the exact
// names testnet and regtest are open networks; launchActive must be exactly
// true. Anything else falls through to the validator format and seed source
// clauses, and a missing options object admits nothing extra.
function admitsPrelaunch(input, { launchActive, seedSources } = {}){
    if(input === null || typeof input !== 'object'){
        throw new TypeError('admitsPrelaunch requires an input object');
    }
    if(OPEN_NETWORKS.includes(input.network) || launchActive === true){
        return true;
    }
    return isValidatorWireAction(input.data)
        || isPrelaunchSeedSource(input.source, input.coin, seedSources);
}

module.exports = { isPrelaunchSeedSource, admitsPrelaunch };
