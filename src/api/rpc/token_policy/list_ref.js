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

function listRefFor({ coin, root, originBlock, sharedLists, mirror }){
    if(!Number.isInteger(root) || !Number.isInteger(originBlock) || !Array.isArray(sharedLists))
        return null;

    const isShared = sharedLists.some(row => row !== null && typeof row === 'object' &&
        Number(row.root_index) === root && Number(row.share_block) <= originBlock);
    if(isShared)
        return `${coin}:${root}`;

    if(mirror !== null && typeof mirror === 'object' &&
        Number(mirror.action_index) === root && Number(mirror.block_index) <= originBlock)
        return `${mirror.home_chain}:${mirror.home_list_index}`;

    return null;
}

module.exports = { listRefFor };
