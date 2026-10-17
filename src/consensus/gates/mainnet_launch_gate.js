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

// prelaunchAdmits: the mainnet launch admission predicate. It reads the launch
// instant (MAINNET_LAUNCH_ACTIVATION) and the seed source map
// (PRELAUNCH_SEED_SOURCES) from its caller and consults no registry.

const { isValidatorWireAction } = require('./validator_wire_actions');
const { isPrelaunchSeedSource } = require('./prelaunch_seed_sources');

const MAINNET = 'mainnet';

function isTime(value){
    return typeof value === 'number' && Number.isFinite(value);
}

// True when the input is admitted: any network other than mainnet, a block time
// at or after launchTime, a validator wire action, or a pinned seed source.
// Anything malformed fails closed with false; a non-object input throws.
function prelaunchAdmits(input, { launchTime, seedSources } = {}){
    if(input === null || typeof input !== 'object'){
        throw new TypeError('prelaunchAdmits requires an input object');
    }
    if(typeof input.network === 'string' && input.network !== '' && input.network !== MAINNET){
        return true;
    }
    if(isTime(launchTime) && isTime(input.blockTime) && input.blockTime >= launchTime){
        return true;
    }
    return isValidatorWireAction(input.data)
        || isPrelaunchSeedSource(input.source, input.coin, seedSources);
}

module.exports = { prelaunchAdmits };
