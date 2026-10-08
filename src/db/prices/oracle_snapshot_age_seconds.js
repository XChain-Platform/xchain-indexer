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

async function readSnapshotAgeSeconds(db, blockIndex, refTime){
    if(!Number.isFinite(refTime)) return Number.MAX_SAFE_INTEGER;
    const rows = await db.doQueryStrict("SELECT MAX(block_timestamp) AS latest_time FROM price_snapshots WHERE status = 'finalized' AND block_timestamp <= ?", [refTime]);
    const latestTime = rows.length > 0 ? rows[0].latest_time : null;
    if(!Number.isFinite(latestTime)) return Number.MAX_SAFE_INTEGER;
    return Math.max(0, refTime - latestTime);
}

module.exports = { readSnapshotAgeSeconds };
