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

const abas       = require('../../archive_batch_author_activation.js');
const diag       = require('./diagnostic_events.js');
const validate   = require('./validate.js');
const reassembly = require('./reassembly.js');

const { getLogger } = require('../../observability/index.js');

// The parent v1 must exist with matching chunk geometry; its absence makes
// this an orphan (stored, but recovery ignores batches that never assemble).
async function resolveChunkParent(handler, data, error){
    let parent = null;
    // The author the batch's chunk set is scoped to, or null while the publisher-scoped
    // flag day is inert (legacy canonical-head rule).
    let scope  = null;
    if(!error){
        // The canonical head (earliest archive-head row for the seq, status-agnostic) is
        // both the legacy parent AND the flag-day anchor, so a head and its chunks
        // can never be judged under two different rules.
        let canonical = await handler.indexerDb.getAnchorV1ByBatchSeq(Number(data['MATCH_BATCH_SEQ']));
        if(canonical && abas.isArchiveBatchAuthorActive(Number(canonical.block_index_doge), handler.config['NETWORK'])){
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
        } else {
            parent = canonical;
        }
        if(!parent)
            data['STATUS'] = 'orphan';
        else if(Number(parent.total_chunks) !== Number(data['TOTAL_CHUNKS']))
            error = 'invalid: TOTAL_CHUNKS (does not match parent v1)';
        // Authorship: "authenticated by its parent v1" now MEANS it. A chunk is valid
        // only when its author is the canonical archive head's author, so a slot can
        // only be occupied by the publisher whose batch it is. Without this, the
        // duplicate guard below turned first-broadcast-wins into permanent denial:
        // anyone could fill a slot with junk and the real chunk was rejected as a
        // duplicate. parent.source comes from actions.source_id (authoritative for
        // auth); a null one means the head's author cannot be resolved at all, which
        // fails closed rather than waving the chunk through unauthenticated.
        // Under a publisher-scoped batch both verdicts are unreachable by construction
        // (the parent was SELECTED by this chunk's author), so they are skipped rather
        // than dead-checked, and a chunk with no head of its own author is an 'orphan'
        // (no head to authenticate against) instead of a rejection.
        else if(scope === null && !parent.source)
            error = 'invalid: SOURCE (archive head author unresolvable)';
        else if(scope === null && String(data['SOURCE'] || '') !== String(parent.source))
            error = 'invalid: SOURCE (not the archive head publisher)';
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
