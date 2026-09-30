'use strict';

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
 *********************************************************************/

function planListRematch(listData, orderIndexes, swapIndexes){
    const matches = [];

    for(const index of new Set(orderIndexes))
        matches.push({ action: 'ORDER_MATCH', index, indexKey: 'ORDER_ACTION_INDEX' });

    for(const index of new Set(swapIndexes))
        matches.push({ action: 'SWAP_MATCH', index, indexKey: 'SWAP_ACTION_INDEX' });

    matches.sort((a, b) => a.index - b.index);

    return matches.map(({ action, index, indexKey }) => ({
        action,
        data: { ...listData, [indexKey]: index }
    }));
}

module.exports = { planListRematch };
