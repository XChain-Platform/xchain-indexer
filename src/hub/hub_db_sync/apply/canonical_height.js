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
 *
 * XChain Indexer - Hub DB Sync Client: canonical block heights
 *
 ********************************************************************/

'use strict';

function canonicalBlockHeight(value){
    if(typeof value === 'number')
        return Number.isSafeInteger(value) && value >= 0 ? value : null;
    if(typeof value !== 'string' || !/^\d+$/.test(value))
        return null;
    let parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

module.exports = { canonicalBlockHeight };
