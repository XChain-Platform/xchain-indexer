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
 * XChain Indexer - cross-chain offer list folds
 *
 * Resolve effective allow and block lists from an offer and its valid edits.
 *
 ********************************************************************/

'use strict';

const { isNull, isNumeric } = require('../../utility/validation/value_checks.js');

function effectiveOfferLists(creation, editsAsc){
    let effective = {
        allow_list: creation.allow_list,
        block_list: creation.block_list
    };
    if(!Array.isArray(editsAsc)) return effective;
    for(let edit of editsAsc){
        for(let field of ['allow_list', 'block_list']){
            if(!isNull(edit[field]) && isNumeric(edit[field])){
                let value = Number(edit[field]);
                effective[field] = value === 0 ? null : value;
            }
        }
    }
    return effective;
}

module.exports = { effectiveOfferLists };
