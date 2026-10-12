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
 * invalid_archive stamp on anchor_actions archive-head parent rows. When the
 * final v2 chunk of a chunked archive batch lands at block B and the
 * reassembled blob fails its CRC check, anchor.js stamps the parent archive
 * head 'invalid_archive' in place. The parent's action_index is in an earlier
 * block, so it is invisible to the action-scoped consensus hashes and to the
 * per-block stream. Resolved via the status name (not status_id) to stay
 * id-independent across nodes.
 *
 * Version predicate GATED: legacy v1-only below the ARCHIVE_INVALID_STATE_HASH
 * activation, the full ARCHIVE_HEAD_VERSIONS set at/after it, so the pre-flag
 * preimage stays byte-identical.
 *
 * Chunk-height key ALSO GATED, on its own separate flag day: the legacy
 * `c.block_index` key is NEVER populated on a v2 continuation row, so this
 * class matched nothing on every node from the day it landed. At/after
 * ARCHIVE_INVALID_HEIGHT_KEY it uses `c.block_index_doge`, the height the
 * completing chunk actually landed at. See the constant for why the two gates
 * are separate and why repairing it is preimage-moving.
 *
 ********************************************************************/

const { isArchiveInvalidStateHashActive, isArchiveInvalidHeightKeyActive,
        archiveHeadPredicate, ARCHIVE_HEAD_VERSIONS_SQL,
        ARCHIVE_CHUNK_HEIGHT_COL, ARCHIVE_CHUNK_HEIGHT_COL_LEGACY } = require('./activation');
const { tolerantQuery } = require('./tolerant_query');

async function collectAnchorInvalid(db, B, network, coin){
    let archiveInvalidActive = isArchiveInvalidStateHashActive(B, network, coin);
    let chunkHeightCol = isArchiveInvalidHeightKeyActive(B, network, coin)
                            ? ARCHIVE_CHUNK_HEIGHT_COL : ARCHIVE_CHUNK_HEIGHT_COL_LEGACY;
    return tolerantQuery(db,
        "SELECT p.action_index, s.status AS status FROM anchor_actions p " +
        "JOIN anchor_actions c ON c.version = 2 AND c.match_batch_seq = p.match_batch_seq " +
        "JOIN index_statuses s ON s.id = p.status_id AND s.status = 'invalid_archive' " +
        "JOIN index_statuses cs ON cs.id = c.status_id AND cs.status = 'valid' " +
        "WHERE " + (archiveInvalidActive
            ? archiveHeadPredicate('p') + " AND p.version " + ARCHIVE_HEAD_VERSIONS_SQL
            : "p.version = 1") +
        " AND " + chunkHeightCol + " BETWEEN ? AND ? " +
        "ORDER BY p.action_index ASC",
        [B, B]);
}

module.exports = { collectAnchorInvalid };
