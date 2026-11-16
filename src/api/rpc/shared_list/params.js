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
const rpcParams = require('../params.js');

function parseSharedListParams(params){
    if(params === null || typeof params !== 'object' || !HOME_CHAINS.has(params.home_chain))
        return { error: 'home_chain must be BTC, LTC or DOGE' };

    let listIndex = rpcParams.integer(params.list_index, { name: 'list_index', min: 1 });
    if(listIndex.error) return { error: listIndex.error };

    return { home_chain: params.home_chain, list_index: listIndex.value };
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
