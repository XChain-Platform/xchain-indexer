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
 * XChain Platform - bridge settle pass: this chain's own settlement ledger.
 *
 * The three reads and the one write that decide whether a leg has already been paid out here.
 * Every one of them goes to the LOCAL bridge_settlements table through the db mixin, never to
 * the mirror, for the reason isSettled's own comment gives.
 *
 ********************************************************************/

'use strict';

const { int } = require('./reasons.js');

/**
 * Has this chain already applied (id, kind)? The read is of the LOCAL bridge_settlements
 * table and never of the mirror, and that is the whole reason the table exists: a mirrored
 * row can be deleted later by a retraction, so "did this chain already apply it?" cannot be a
 * question the mirror answers. `kind` is inside the unique key, so a transfer id and a
 * snapshot id may collide in the id column without colliding as settlements.
 *
 * @param {Object} indexerDb
 * @param {string} id
 * @param {string} kind - 'transfer' or 'policy'
 * @returns {Promise<boolean>}
 */
async function isSettled(indexerDb, id, kind){
    return await indexerDb.isBridgeSettlementRecorded(id, kind);
}

/**
 * Has this chain already applied a TRANSFER settlement for this SOURCE leg, under any
 * transfer_id? The indexer is the ledger of record, so at most one settlement per source leg
 * may ever apply here: one v0/v3 lock or v1/v4 burn funds exactly one mint or release, which is
 * what the base spec's supply invariant counts when it says a transfer is in flight "from the
 * block its source leg (lock or burn) applies until the block its destination leg (mint or
 * release) applies". The hub guards the same rule at finalization, but a duplicate that escapes
 * a future hub, a mesh running an older build or a later regression would otherwise mint or
 * release a second time here, and a double mint is the one direction the invariant cannot
 * recover from (there is no destination-side unwind).
 *
 * KEYED ON THE SOURCE LEG ALONE, never on transfer_id. transfer_id carries snapshot_block by
 * design, so two rows naming one leg differ in id, and an id-keyed test is
 * exactly the hole the measured duplicates came through: eleven finalized rows for seven source
 * legs, all eleven distinct ids.
 *
 * READ FROM THE LOCAL bridge_settlements TABLE and never from the mirror, for the reason
 * isSettled gives, with a second consequence that matters here: a row retracted before it
 * applied leaves no settlement behind, so a re-formed row for the same leg (a new id, a new
 * snapshot_block) still applies, and applies exactly once.
 *
 * @param {Object} indexerDb
 * @param {string} srcChain - the lock/burn chain, as signed
 * @param {number|string} srcActionIndex - the lock/burn action_index, as signed
 * @returns {Promise<boolean>} false when the row names no usable source leg; the caller's
 *          ROW_FIELDS refusal owns that case, so this never answers a uniqueness question it
 *          has no key for
 */
async function isSourceLegSettled(indexerDb, srcChain, srcActionIndex){
    const idx = int(srcActionIndex);
    if(!srcChain || idx === null) return false;
    return await indexerDb.isBridgeSourceLegSettled(srcChain, idx);
}

/**
 * Record the applied leg. INSERT IGNORE on (transfer_id, kind), the recordCrossChainSettlement
 * shape: the action_index is rollback-able, so a reorg below the applying block drops this row
 * and the transfer re-applies at a fresh index.
 */
async function recordSettlement(indexerDb, actionIndex, id, kind, blockIndex, row){
    await indexerDb.recordBridgeSettlement(
        actionIndex, id, kind, blockIndex,
        row.src_chain || null,
        (row.src_action_index === null || row.src_action_index === undefined) ? null : Number(row.src_action_index),
        row.dest_chain || null, row.dest_address || null, row.tick || null);
}

module.exports = { isSettled, isSourceLegSettled, recordSettlement };
