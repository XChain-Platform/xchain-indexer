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

const gateRegistry = require('../consensus/gate_registry');
const { pickMaxPriceAgeSeconds } = require('./price_age/pick.js');

const HOURLY_PRICE_AGE_GATE =
    'oracle_price_age_hourly_activation.ORACLE_PRICE_AGE_HOURLY_ACTIVATION';

function maxPriceAgeSecondsAt(config, network, chainKey, blockIndex){
    let hourlyActive = gateRegistry.activeAt(
        HOURLY_PRICE_AGE_GATE, network, chainKey, blockIndex, null);
    return pickMaxPriceAgeSeconds(config, hourlyActive);
}

module.exports = { maxPriceAgeSecondsAt };
