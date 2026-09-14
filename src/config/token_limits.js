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
 * Token decimal, supply, description and memo limits of src/config.js's
 * getConfig(). The tick and BET limits around them stay in src/config.js,
 * where sibling repos read them out of its text.
 ********************************************************************/

'use strict';

function applyTokenSupplyLimits(config){
    // Min/Max DECIMALS
    config['MIN_TOKEN_DECIMALS'] = 0;
    config['MAX_TOKEN_DECIMALS'] = 18;

    // Min/Max SUPPLY (stored as strings to preserve full precision beyond Number.MAX_SAFE_INTEGER)
    config['MIN_TOKEN_SUPPLY'] = '0.000000000000000001';
    config['MAX_TOKEN_SUPPLY'] = '1000000000000000000000';

    // Max DESCRIPTION length
    config['MAX_TOKEN_DESCRIPTION'] = 250;

    // Max MEMO length
    config['MAX_MEMO_LENGTH'] = 250;
}

module.exports = { applyTokenSupplyLimits };
