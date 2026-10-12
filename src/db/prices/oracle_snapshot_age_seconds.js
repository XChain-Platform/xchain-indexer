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
 *
 * XChain Indexer - Database mixin part: prices (snapshot age in seconds)
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

const gateRegistry = require('../../consensus/gate_registry');

const SECONDS_ACTIVATION = 'oracle_snapshot_age_seconds_activation.ORACLE_SNAPSHOT_AGE_SECONDS_ACTIVATION';

function secondsBasisActive(db, blockIndex){
    return gateRegistry.activeAt(SECONDS_ACTIVATION, db.config['NETWORK'], db.config['COIN'], blockIndex, null);
}

async function readAgeSeconds(db, blockIndex, refTime, win){
    const { blockCap, timeBound, timeArgs } = win;
    const query = "SELECT MAX(block_timestamp) AS latest_time FROM price_snapshots"
                + " WHERE status = 'finalized' AND reference_block <= ?"
                + timeBound;
    const rows = await db.doQueryStrict(query, [blockCap, ...timeArgs]);
    const latest = (rows.length > 0 && rows[0].latest_time !== null) ? Number(rows[0].latest_time) : 0;
    if(!(latest > 0) || !Number.isFinite(refTime)) return Number.MAX_SAFE_INTEGER;
    return Math.max(0, refTime - latest);
}

module.exports = { readSnapshotAgeSeconds, secondsBasisActive, readAgeSeconds, SECONDS_ACTIVATION };
