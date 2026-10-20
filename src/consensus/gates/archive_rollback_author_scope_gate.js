/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * Publisher-scoped archive rollback reset flag-day.
 *
 * THE PROBLEM. The reorg reset that clears a wedged 'invalid_archive' stamp off
 * a surviving archive head self-joins the head to an orphaned v2 chunk on
 * MATCH_BATCH_SEQ alone. That seq is not unique, and archive batches are
 * publisher-scoped (each head reassembles only its own publisher's chunks), so
 * two publishers can hold two live batches under one seq, each with its own head
 * and its own chunks stored 'valid'. One publisher's orphaned chunk then resets
 * the OTHER publisher's head, whose own batch is intact below the reorg and whose
 * stamp a from-genesis replay still re-derives.
 *
 * THE RULE. Above the threshold the orphaned chunk must be authored by the same
 * address as the head it resets, resolved through actions.source_id (the
 * authoritative source for auth, never re-derived from the transaction). Inner
 * joins throughout, so a row whose action linkage cannot be resolved is excluded
 * and no reset fires: fail-closed by shape, matching the archive read path.
 *
 * ARMING PRECONDITION. Author equality is the exact batch key because both
 * forward stamping paths scope the chunk set to the head's OWN author at every
 * height on every network (the indexer ANCHOR handler's archiveAuthorScope and
 * its archive chunk path), so the precondition holds wherever this gate is
 * armed. It holds only while that scoping stays unconditional: a forward path
 * that scoped a batch to the CANONICAL head's author would give a second head
 * stamped by the head-side gate a different author than the chunks that stamped
 * it, and this term would then suppress a reset that is genuinely owed.
 *
 * WHY GATED AT ALL. The reset is not a hash preimage (the class-6 anchor_invalid
 * projection covers the stamp itself), and a from-genesis replay never runs
 * rollback, so historical replay is byte-identical either way. The gate exists
 * because the reset writes state the class-6 preimage READS, so two nodes that
 * reorged under different rules answer a later recompute differently: the
 * switchover wants one coordinated height per network, not a deploy race.
 *
 * ARMED ON MAINNET AND TESTNET (2026-09-09 ruling); regtest keeps the inert
 * sentinel so the flag-day-off control path stays drivable. On regtest, and on
 * testnet for a rollback targeting below its armed height, the unscoped reset
 * runs beside author-scoped forward stamping and can reproduce the
 * cross-publisher reset described under THE PROBLEM, so such a run is no
 * evidence about the scoped reset. A replica reads its
 * threshold only once it has a network, so ClientRollback now REQUIRES one at
 * construction rather than treating an omitted network as inactive: with a live
 * threshold, silently falling back to the legacy unscoped reset is the fleet
 * split this gate exists to prevent.
 *
 * KEYED ON THE ROLLBACK'S OWN TARGET BLOCK, per network, on the DOGE scale the
 * ANCHOR actions land on. The orphaned chunk always sits at or above that
 * height, so the rule that judges it is the rule in force where it landed.
 *
 ********************************************************************/

'use strict';

const { get, copy, activeAt } = require('../gate_registry');

const ARCHIVE_ROLLBACK_AUTHOR_SCOPE_ACTIVATION = copy('archive_rollback_author_scope_activation.ARCHIVE_ROLLBACK_AUTHOR_SCOPE_ACTIVATION');

const ARCHIVE_AUTHOR_SCOPE_JOIN_SQL = copy('archive_rollback_author_scope_activation.ARCHIVE_AUTHOR_SCOPE_JOIN_SQL');

// Whether the reset is publisher-scoped for a rollback targeting `blockIndex` on
// `network`. A non-numeric height, an unknown network or an omitted one -> false
// (legacy unscoped reset, deployed behavior kept).
function isArchiveRollbackAuthorScopeActive(blockIndex, network){
    let b = parseInt(blockIndex);
    if(!Number.isFinite(b)) return false;
    let threshold = ARCHIVE_ROLLBACK_AUTHOR_SCOPE_ACTIVATION[network];
    if(threshold === undefined) return false;
    return b >= threshold;
}

// The join text to splice, or an empty string below the threshold.
function archiveAuthorScopeJoin(blockIndex, network){
    return isArchiveRollbackAuthorScopeActive(blockIndex, network) ? ARCHIVE_AUTHOR_SCOPE_JOIN_SQL : '';
}

module.exports = {
    ARCHIVE_ROLLBACK_AUTHOR_SCOPE_ACTIVATION,
    ARCHIVE_AUTHOR_SCOPE_JOIN_SQL,
    isArchiveRollbackAuthorScopeActive,
    archiveAuthorScopeJoin
};
