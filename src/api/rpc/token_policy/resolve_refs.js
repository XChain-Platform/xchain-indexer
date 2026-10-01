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

const { listRefFor } = require('./list_ref.js');
const { getSharedLists } = require('../../../db/lists/sharing.js');

async function resolveSide(db, { coin, index, originBlock, sharedLists }){
    if(index === null || index === undefined)
        return null;

    const root = Number(await db.getListRootIndex(index, 16, originBlock));
    const mirror = await db.getListShareMirrorByIndex(root);
    return listRefFor({ coin, root, originBlock, sharedLists, mirror });
}

async function resolvePolicyRefs(db, { coin, allowIndex, blockIndex, originBlock }){
    if((allowIndex === null || allowIndex === undefined) &&
        (blockIndex === null || blockIndex === undefined))
        return { allowRef: null, blockRef: null };

    const sharedLists = await getSharedLists(db);
    const allowRef = await resolveSide(db,
        { coin, index: allowIndex, originBlock, sharedLists });
    const blockRef = await resolveSide(db,
        { coin, index: blockIndex, originBlock, sharedLists });
    return { allowRef, blockRef };
}

module.exports = { resolvePolicyRefs };
