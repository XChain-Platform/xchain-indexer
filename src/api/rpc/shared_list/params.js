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

const HOME_CHAINS = new Set(['BTC', 'LTC', 'DOGE']);
const CANONICAL_POSITIVE_INTEGER = /^[1-9][0-9]*$/;

function parseSharedListParams(params){
    if(params === null || typeof params !== 'object' || !HOME_CHAINS.has(params.home_chain))
        return { error: 'home_chain must be BTC, LTC or DOGE' };

    let listIndex = params.list_index;
    if(typeof listIndex === 'string'){
        if(!CANONICAL_POSITIVE_INTEGER.test(listIndex))
            return { error: 'list_index must be a positive integer' };
        listIndex = Number(listIndex);
    }

    if(!Number.isSafeInteger(listIndex) || listIndex <= 0)
        return { error: 'list_index must be a positive integer' };

    return { home_chain: params.home_chain, list_index: listIndex };
}

function sharedListRecord({ home_chain, home_list_index, local_list_index, seq, origin_block, members }){
    return {
        home_chain,
        home_list_index,
        local_list_index,
        seq,
        origin_block,
        members: members.slice().sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
    };
}

module.exports = { parseSharedListParams, sharedListRecord };
