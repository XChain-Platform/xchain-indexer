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
 **********************************************************************/

// test/unit/blockhash_conformance_twin.test/helpers/pair_loader.js
//
// Builds the source-pair loader while retaining the caller's sibling policy.

'use strict';

function makeLoadPair({ fs, requireSibling, syncFile, indexerSource }) {
    return function loadPair(ctx, syncRel, indexerRel){
        if(!requireSibling(ctx, syncFile(syncRel))) return null;
        return {
            sync:    fs.readFileSync(syncFile(syncRel), 'utf8'),
            indexer: indexerSource(indexerRel)
        };
    };
}

module.exports = { makeLoadPair };
