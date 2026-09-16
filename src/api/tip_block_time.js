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
 * XChain Indexer - tip block time for the open cross-chain book
 *
 * The block_time the open cross-chain offer read in src/api.js filters
 * expired offers against, read off the committed view the handler bound.
 *
 ********************************************************************/

'use strict';

// getBlockTime returns the `false` sentinel on a missing block / older-schema gap;
// coerce that (and any non-finite) to null so the filter is skipped rather than
// running as a `>= 0` no-op or, worse, a `>= NaN` that drops the whole book.
async function tipBlockTime(db, latest){
    let rawBlockTime = await db.getBlockTime(latest);
    return (rawBlockTime !== false && Number.isFinite(Number(rawBlockTime)))
        ? Number(rawBlockTime) : null;
}

module.exports = { tipBlockTime };
