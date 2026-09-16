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
 * XChain Indexer - Database statements: rollback batch head resets
 *
 * The two self-joins that restore a batch head an orphaned completing chunk stamped
 * in place, each one the body of the src/rollback/batch_heads.js method of the same
 * name, where the safety argument is stated. Run inside the rollback transaction.
 *
 ********************************************************************/

'use strict';

const { ARCHIVE_HEAD_VERSIONS_SQL } = require('../../stateHash.js');
const { archiveAuthorScopeJoin } = require('../../archive_rollback_author_scope_activation.js');
// Wire versions only, for the ATTEST batch-link retraction below: the head and the
// continuation are what make an `attests` row part of a batch, and naming them from the
// wire module keeps the reorg query and the parser reading the same two numbers.
const abw       = require('../../actions/attest/attest_batch_wire.js');
// Byte-identical copy of actions/attest.js's ATTEST_BATCH_COMPLETION_STAMP, the marker a
// completing v6 continuation appends to the verdict it stamps on a surviving v5 head. The
// reorg reset below restores ONLY marked stamps; the constant is duplicated rather than
// required (the rollback requires no action handler) and a test pins the two copies equal.
const ATTEST_BATCH_COMPLETION_STAMP = ' (stamped on batch completion)';

module.exports = {

    // The archive head an orphaned valid v2 chunk stamped invalid_archive goes back to unverified.
    async resetOrphanedArchiveHeads(db, config, block_index, firstActionIndex){
        let query, args;
        if(firstActionIndex !== null){
            // Intern 'unverified' FIRST (IDX-1). The UPDATE below resolves its target id via
            // `JOIN index_statuses us ON us.status = 'unverified'`, but a normally hub-connected
            // node never writes 'unverified' forward (anchor.js only stores it when no
            // oracle_publish snapshot is mirrored), so that row is usually absent and the JOIN
            // matches nothing, silently no-oping the reset and leaving the parent wedged at
            // 'invalid_archive'. createStatus interns it (INSERT IGNORE) so the JOIN is
            // guaranteed non-empty; index_statuses ids are never hashed, so an in-rollback
            // intern is byte-neutral. The UPDATE's JOIN text is pinned by the cross-repo
            // drift guard (xchain-sync rollback_coverage); the replica converges via
            // snapshot catch-up (it cannot intern locally without diverging the replicated
            // id, and anchor status_id is in no block-hash projection).
            //
            // Version predicate: the parent is any ARCHIVE_HEAD version (today v1, the
            // publisher-bearing archive head), spliced from the stateHash.js constant
            // rather than hand-copied, so a head version added later reaches this reset
            // too. No flag day gates it: every head version's stamp is equally
            // un-re-derivable after the chunk delete, and this reset is not a hash
            // preimage (the GATED anchor_invalid state-hash class covers the stamp
            // itself). client/rollback.js mirrors this; the drift guard pins the
            // predicate on both sides.
            //
            // Author scope, flag-day gated and INERT on every network today: the seq is
            // not a batch key once archive batches are publisher-scoped, so a second
            // publisher's orphaned chunk resets a head whose own batch survives intact.
            // Rationale + arming precondition: archive_rollback_author_scope_activation.js.
            await db.createStatus('unverified');
            let authorScope = archiveAuthorScopeJoin(block_index, String(config['NETWORK'] || ''));
            query = `UPDATE anchor_actions p
                        JOIN index_statuses ps ON ps.id = p.status_id AND ps.status = 'invalid_archive'
                        JOIN anchor_actions c
                          ON c.version = 2
                         AND c.match_batch_seq = p.match_batch_seq
                         AND c.action_index >= ?
                        JOIN index_statuses cs ON cs.id = c.status_id AND cs.status = 'valid'
                        ${authorScope}
                        JOIN index_statuses us ON us.status = 'unverified'
                        SET p.status_id = us.id
                        WHERE p.version ${ARCHIVE_HEAD_VERSIONS_SQL}
                          AND p.action_index < ?`;
            args = [firstActionIndex, firstActionIndex];
            await db.doQuery(query, args);
        }
    },

    // The v5 head an orphaned valid v6 continuation stamped goes back to valid.
    async restoreStampedAttestHeads(db, firstActionIndex){
        let query, args;
        if(firstActionIndex !== null){
            // Intern 'valid' first, for the archive reset's reason: the UPDATE resolves
            // its target id through `JOIN index_statuses vs ON vs.status = 'valid'`, and
            // a JOIN that matches nothing silently no-ops the reset. index_statuses ids
            // are never hashed, so an in-rollback intern is byte-neutral.
            await db.createStatus('valid');
            query = `UPDATE attests p
                        JOIN index_statuses ps ON ps.id = p.status_id AND ps.status LIKE ?
                        JOIN actions        pa ON pa.action_index = p.action_index
                        JOIN attests c
                          ON c.request_id = p.request_id
                         AND c.version = ${abw.ATTEST_BATCH_CONTINUATION_VERSION}
                         AND c.batch_chunk_index IS NOT NULL
                         AND c.action_index >= ?
                        JOIN index_statuses cs ON cs.id = c.status_id AND cs.status = 'valid'
                        JOIN actions        ca ON ca.action_index = c.action_index
                                              AND ca.source_id    = pa.source_id
                        JOIN index_statuses vs ON vs.status = 'valid'
                        SET p.status_id = vs.id
                        WHERE p.version = ${abw.ATTEST_BATCH_HEAD_VERSION}
                          AND p.batch_chunk_index = 0
                          AND p.action_index < ?`;
            args = ['%' + ATTEST_BATCH_COMPLETION_STAMP, firstActionIndex, firstActionIndex];
            await db.doQuery(query, args);
        }
    },

};
