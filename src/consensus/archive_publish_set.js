/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 ********************************************************************/

'use strict';

const gateRegistry = require('./gate_registry.js');
const swq = require('./stake_weighted_quorum.js');

const ARCHIVE_PUBLISH_CAPABILITY = 'archive_publish';
const ARCHIVE_ROLLCALL_PRESENCE_KEY =
    'archive_rollcall_presence_activation.ARCHIVE_ROLLCALL_PRESENCE_ACTIVATION';

// Archive publishing is proven under the oracle_publish base capability key.
function proofCapabilityFor(capability){
    return capability === ARCHIVE_PUBLISH_CAPABILITY ? 'oracle_publish' : capability;
}

// Map only archive rows so proof verification uses the base capability key.
function proofRowFor(row){
    const capability = proofCapabilityFor(row.capability);
    if(capability === row.capability) return row;
    return { ...row, capability };
}

function isArchivePublishSetActive(snapshotBlock, network){
    if(!swq.isStakeWeightedQuorumActive(snapshotBlock, network)) return false;
    return gateRegistry.activeAt(
        ARCHIVE_ROLLCALL_PRESENCE_KEY, network, 'BTC', snapshotBlock, null);
}

function subtractAbsentSources(weights, absentSources){
    if(!Array.isArray(weights) || weights.length === 0) return weights;
    let absent = new Set((absentSources || []).map((source) => String(source)));
    if(absent.size === 0) return weights;
    let filtered = weights.filter((row) => row && !absent.has(String(row.source)));
    if(filtered.length === weights.length) return weights;
    if(weights.truncated === true) filtered.truncated = true;
    return filtered;
}

async function getArchivePublishSet(indexerDb, snapshotBlock, network){
    let weights = await indexerDb.getStakeWeightsByCapability('oracle_publish', snapshotBlock);
    if(!isArchivePublishSetActive(snapshotBlock, network)) return weights;
    let absent = await indexerDb.getLatestRolledRollcallAbsentSources(snapshotBlock);
    return subtractAbsentSources(weights, absent);
}

module.exports = {
    ARCHIVE_PUBLISH_CAPABILITY,
    ARCHIVE_ROLLCALL_PRESENCE_KEY,
    proofCapabilityFor,
    proofRowFor,
    isArchivePublishSetActive,
    subtractAbsentSources,
    getArchivePublishSet,
};
