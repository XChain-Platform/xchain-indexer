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

function pickMaxPriceAgeSeconds(config, hourlyActive){
    config = config || {};
    let key = hourlyActive === true
        ? 'ORACLE_MAX_PRICE_AGE_HOURLY_SECONDS'
        : 'ORACLE_MAX_PRICE_AGE_SECONDS';
    return parseInt(config[key]) || 1800;
}

module.exports = { pickMaxPriceAgeSeconds };
