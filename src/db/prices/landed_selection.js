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
 ********************************************************************/

'use strict';

const gateRegistry = require('../../consensus/gate_registry.js');

function landedSelection(config, blockHeight) {
    const landedActive = gateRegistry.activeAt(
        'price_fee_batch_landed_activation.PRICE_FEE_BATCH_LANDED_ACTIVATION',
        config['NETWORK'], config['COIN'], blockHeight, null);
    const landingSets = gateRegistry.get('price_fee_batch_landed_activation.PRICE_LANDING_CHAINS');
    const landingSet = Object.prototype.hasOwnProperty.call(landingSets, config['NETWORK'])
        ? landingSets[config['NETWORK']] : [];
    const ownCoin = String(config['COIN'] || '').trim().toUpperCase();
    const landedStrict = landedActive && landingSet.includes(ownCoin) &&
        gateRegistry.activeAt('price_landed_strict_activation.PRICE_LANDED_STRICT_ACTIVATION',
            config['NETWORK'], config['COIN'], blockHeight, null);
    return { landedActive, landedStrict };
}

module.exports = { landedSelection };
