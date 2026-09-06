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
 * MATCH_BATCH_SEQ alone. That seq is not unique, and once archive batches are
 * publisher-scoped (archive_batch_author_activation.js) two publishers can hold
 * two live batches under one seq, each with its own head and its own chunks
 * stored 'valid'. One publisher's orphaned chunk then resets the OTHER
 * publisher's head, whose own batch is intact below the reorg and whose stamp a
 * from-genesis replay still re-derives.
 *
 * THE RULE. Above the threshold the orphaned chunk must be authored by the same
 * address as the head it resets, resolved through actions.source_id (the
 * authoritative source for auth, never re-derived from the transaction). Inner
 * joins throughout, so a row whose action linkage cannot be resolved is excluded
 * and no reset fires: fail-closed by shape, matching the archive read path.
 *
 * ARMING PRECONDITION. Author equality is the exact batch key ONLY at or above
 * that network's ARCHIVE_BATCH_AUTHOR height, where both stamping paths in
 * anchor.js scope the chunk set to the head's own author. Below it the chunk set
 * is scoped to the CANONICAL head's author, so a second head stamped by the
 * head-side gate has a different author than the chunks that stamped it and the
 * term would suppress a reset that is genuinely owed. Never arm a network here
 * below its ARCHIVE_BATCH_AUTHOR height; a parity test pins the ordering.
 *
 * Residual the arming height must clear: a batch whose canonical head landed
 * BELOW that network's ARCHIVE_BATCH_AUTHOR height keeps the legacy canonical
 * head rule forever, so a squatting second head on such a batch still resolves
 * to a foreign author. Arm at a height with no such batch still taking chunks.
 *
 * WHY GATED AT ALL. The reset is not a hash preimage (the class-6 anchor_invalid
 * projection covers the stamp itself), and a from-genesis replay never runs
 * rollback, so historical replay is byte-identical either way. The gate exists
 * because the reset writes state the class-6 preimage READS, so two nodes that
 * reorged under different rules answer a later recompute differently: the
 * switchover wants one coordinated height per network, not a deploy race.
 *
 * SHIPS INERT ON EVERY NETWORK. Arming is a one-line edit here per network, and
 * a replica arms only once SyncService hands ClientRollback its network: an
 * omitted network reads as inactive, which is correct while every threshold is
 * inert and wrong the moment one is not. A guard test in xchain-sync fails if a
 * threshold is armed while that wiring is still optional.
 *
 * KEYED ON THE ROLLBACK'S OWN TARGET BLOCK, per network, on the DOGE scale the
 * ANCHOR actions land on. The orphaned chunk always sits at or above that
 * height, so the rule that judges it is the rule in force where it landed.
 *
 ********************************************************************/

'use strict';

// Per-network activation, interpreted against the block index a rollback targets.
// Every key is an INERT placeholder: no live network can reach it, so the reset
// keeps its deployed unscoped shape until an operator pins a real height.
const ARCHIVE_ROLLBACK_AUTHOR_SCOPE_ACTIVATION = {
    mainnet: 9999999999,   // INERT placeholder; pin on the coordinated activation train, never below ARCHIVE_BATCH_AUTHOR
    testnet: 9999999999,   // INERT placeholder; testnet arms ARCHIVE_BATCH_AUTHOR at 0, so any height here is legal once the wiring lands
    regtest: 9999999999,   // INERT placeholder
};

// The joins that bind an orphaned chunk to its own head's author. Spliced into
// the reset UPDATE by both the source indexer and the replica so the two cannot
// drift; `c` is the orphaned chunk and `p` the surviving head, as named there.
const ARCHIVE_AUTHOR_SCOPE_JOIN_SQL =
    'JOIN actions         pact ON pact.action_index = p.action_index ' +
    'JOIN index_addresses padr ON padr.id = pact.source_id ' +
    'JOIN actions         cact ON cact.action_index = c.action_index ' +
    'JOIN index_addresses cadr ON cadr.id = cact.source_id AND cadr.address = padr.address ';

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
