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
 * ANCHOR v2, the archive continuation chunk, authenticated by its parent v1.
 * Reached through Anchor.parseContinuation in index.js; the field checks live
 * in validate.js and the completing chunk's CRC gate in reassembly.js.
 *
 ********************************************************************/

const diag       = require('../diagnostic_events.js');
const validate   = require('../validate.js');
const reassembly = require('../reassembly.js');

const { getLogger } = require('../../../observability/index.js');

// The parent v1 must exist with matching chunk geometry; its absence makes
// this an orphan (stored, but recovery ignores batches that never assemble).
async function resolveChunkParent(handler, data, error){
    let parent = null;
    // The author the batch's chunk set is scoped to, or null when there is no parent.
    let scope  = null;
    if(!error){
        // The canonical head (earliest archive-head row for the seq, status-agnostic) is
        // resolved first so every node starts from the same row before selecting the
        // earliest head authored by this chunk's publisher.
        let canonical = await handler.indexerDb.getAnchorV1ByBatchSeq(Number(data['MATCH_BATCH_SEQ']));
        if(canonical){
            // Publisher-scoped batch: the parent is the earliest head for this seq
            // authored by THIS chunk's publisher. A junk head squatting the seq is
            // then the head of its own batch only, and governs neither the geometry
            // gate nor the chunk set of anyone else's. A chunk with no resolvable
            // author of its own scopes to nothing and lands 'orphan' (fail-closed).
            scope  = String(data['SOURCE'] || '');
            parent = !scope ? null
                   : (String(canonical.source || '') === scope)
                        ? canonical
                        : await handler.indexerDb.getAnchorV1ByBatchSeq(Number(data['MATCH_BATCH_SEQ']), scope);
        }
        if(!parent)
            data['STATUS'] = 'orphan';
        else if(Number(parent.total_chunks) !== Number(data['TOTAL_CHUNKS']))
            error = 'invalid: TOTAL_CHUNKS (does not match parent v1)';
    }
    return { error, parent, scope };
}

// Duplicate chunk guard (same batch + index already stored). The occupancy set
// getAnchorChunks returns is author-bound, so a junk chunk that landed BEFORE the
// head (status 'orphan', no verdict of its own) no longer counts as occupying the
// slot and can no longer get the real chunk rejected here. The occupancy set is
// this publisher's own, so a slot filled in someone else's batch at the same seq
// does not collide either.
async function checkDuplicateChunk(handler, data, parent, scope, error){
    if(!error && parent){
        let existing = await handler.indexerDb.getAnchorChunks(Number(data['MATCH_BATCH_SEQ']), scope);
        if(existing.some(c => Number(c.chunk_index) === Number(data['CHUNK_INDEX'])))
            error = 'invalid: CHUNK_INDEX (duplicate)';
    }
    return error;
}

// The chunk's log line, failure event and anchor_actions row.
async function recordChunk(handler, data, parent){
    getLogger().info("\t ANCHOR v2 : batch " + data['MATCH_BATCH_SEQ'] + ' chunk ' + data['CHUNK_INDEX'] +
                '/' + data['TOTAL_CHUNKS'] + ' : ' + data['STATUS']);

    // A continuation chunk carries no chain of its own; the batch seq is what
    // ties it back to the head that names one.
    if(diag.isAnchorFailureStatus(data['STATUS']))
        diag.noteAnchorFailed({
            chain:           parent ? parent.chain : undefined,
            reason:          data['STATUS'],
            network:         handler.config['NETWORK'],
            version:         2,
            match_batch_seq: data['MATCH_BATCH_SEQ'],
            chunk_index:     data['CHUNK_INDEX'],
            block_index:     data['BLOCK_INDEX']
        });

    await handler.indexerDb.createAnchorAction(data);
}

// ANCHOR v2: archive continuation chunk (authenticated by its parent v1)
async function parseArchiveChunk(handler, params, data, error){
    error = validate.validateChunkFields(params, data, error);

    let resolved = await resolveChunkParent(handler, data, error);
    let { parent, scope } = resolved;
    error = resolved.error;

    error = await checkDuplicateChunk(handler, data, parent, scope, error);

    if(!data['STATUS']) data['STATUS'] = (error) ? error : 'valid';
    await recordChunk(handler, data, parent);

    await reassembly.reassembleAtChunk(handler, data, parent, scope, error);

    await handler.mapper.createMappings(data);
}

module.exports = { parseArchiveChunk };
