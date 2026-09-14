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
 * XChain Indexer - capability-validator request steps
 *
 * Keeps validation and operator logging independently testable while the API
 * handler retains the database-view and consensus-filter wiring it owns.
 *
 ********************************************************************/

'use strict';

const gatesFilter = require('../actions/attest/rollcall_gates_filter.js');
const { getLogger } = require('../observability/index.js');

// Validate request fields in API error-precedence order and normalize the block.
function parseCapabilityRequest({capability, block_index}){
    if(!capability || typeof capability !== 'string')
        return { error: 'capability is required' };
    if(block_index === undefined || block_index === null)
        return { error: 'block_index is required' };
    let blk = Number(block_index);
    if(!Number.isInteger(blk) || blk < 0)
        return { error: 'block_index must be a non-negative integer' };
    return { blk };
}

// Distinguish local capability config drift from a legitimately empty set.
function unconfiguredCapabilityError(db, capability){
    // A capability absent from this indexer's STAKING.CAPABILITIES config would
    // otherwise produce an empty validator set indistinguishable from "no
    // qualified validators at this block". Surface it as an error so the hub's
    // CapabilitySnapshot treats it as a null snapshot (degraded mode) and the
    // operator gets a signal of config drift instead of a silent attestation drop.
    if(!db.isCapabilityConfigured(capability))
        return { error: 'capability not configured: ' + capability };
    return null;
}

// Reject a future block only after reading the latest committed index height.
async function notYetIndexedError(db, blk){
    let latestBlock = await db.getLatestBlockIndex();
    if(blk > latestBlock)
        return { error: 'block_index ' + blk + ' not yet indexed (latest: ' + latestBlock + ')' };
    return null;
}

// Emit the bounded rules-filter summary only when the formatter has content.
function logGatesFilterStats(gatesStats){
    let line = gatesFilter.formatGatesFilterStats(gatesStats);
    if(line) getLogger().info('getcapabilityvalidators: ' + line);
}

// Record whether the effective threshold came from the caller or local config.
function logSnapshotThreshold(capability, blk, min_stake, count){
    // Confirm which threshold this snapshot actually filtered by, so a
    // hub↔indexer MIN_STAKE mismatch is visible in the indexer log
    // rather than surfacing only as a silently-divergent quorum N.
    let thresholdSource = (min_stake !== undefined && min_stake !== null)
        ? String(min_stake) + ' (caller-supplied)'
        : 'local-config';
    getLogger().info('getcapabilityvalidators: capability=' + capability +
        ' block=' + blk + ' min_stake=' + thresholdSource +
        ' validators=' + count);
}

module.exports = {
    parseCapabilityRequest,
    unconfiguredCapabilityError,
    notYetIndexedError,
    logGatesFilterStats,
    logSnapshotThreshold
};
