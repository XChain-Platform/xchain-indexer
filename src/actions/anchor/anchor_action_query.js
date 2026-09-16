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
 * Pure helpers for the getanchoraction RPC (api.js) and its db read
 * (db.js getAnchorActionByCheckpoint), extracted for unit testing because
 * startApi() is not importable (it opens DB connections). The DB read itself
 * is exercised on regtest / integration; this module holds the request
 * validation, the checkpoint-version set, and the row -> response mapping
 * (including DOGE confirmation-depth math), which is the regression-worthy logic.
 *
 ********************************************************************/

'use strict';

// ARCHIVE_HEAD_VERSIONS is the archive-head version set, re-exported below for the
// callers that reason about versions. Its SQL fragment form is consumed only by the
// statements, so it is imported where they live.
const { ARCHIVE_HEAD_VERSIONS } = require('../../stateHash.js');

// The anchor_actions STATEMENTS live in src/db/anchor_sql.js, beside the tables they
// name, and are re-exported below so every existing caller keeps importing them from
// here. They are constants rather than mixin methods because three layers run the
// identical text on three different connections: the db class, the RPC layer, and
// the recovery tool, which holds only a doQuery handle and no Database at all.
const {
    CHECKPOINT_VERSIONS, CHECKPOINT_SECTION_VERSIONS, CHECKPOINT_SECTION_VERSIONS_SQL,
    ANCHOR_ROW_LIMIT, ANCHOR_ACTIONS_SQL,
    ARCHIVE_HEAD_AUTHOR_SQL, ARCHIVE_CHUNK_SET_SQL, ARCHIVE_CHUNK_SET_BY_AUTHOR_SQL,
    ARCHIVE_HEAD_GATE_SQL,
    ARCHIVE_ANCHOR_ROW_LIMIT, ARCHIVE_ANCHOR_BY_CONTENT_SQL,
    ANCHOR_BY_TXID_COLUMNS, ANCHOR_BY_TXID_SQL, ANCHOR_BY_TXID_AFTER_SQL
} = require('../../db/anchor_sql.js');

// The three reads this module serves live in anchor_action_query/, one file per
// question: a checkpoint (action_query), a transaction (confirmations_query), and a
// batch's content (archive_query). This file stays the entry every caller requires,
// re-exporting exactly the names it always has, so the split is invisible outside it.
const { validateAnchorActionParams, selectAnchorRow,
        buildAnchorActionResponse } = require('./anchor_action_query/action_query.js');
const { validateAnchorConfirmationsParams,
        buildAnchorConfirmationsResponse } = require('./anchor_action_query/confirmations_query.js');
const { ARCHIVE_CRC_RE, dedupeArchiveChunks, archiveChunkCoverage,
        validateArchiveAnchorParams, selectArchiveHeadRow, presentChunkIndexes,
        buildArchiveAnchorResponse } = require('./anchor_action_query/archive_query.js');

module.exports = {
    CHECKPOINT_VERSIONS, CHECKPOINT_SECTION_VERSIONS, CHECKPOINT_SECTION_VERSIONS_SQL,
    ANCHOR_ROW_LIMIT, ANCHOR_ACTIONS_SQL,
    ARCHIVE_HEAD_AUTHOR_SQL, ARCHIVE_CHUNK_SET_SQL, ARCHIVE_CHUNK_SET_BY_AUTHOR_SQL,
    ARCHIVE_HEAD_GATE_SQL, dedupeArchiveChunks, archiveChunkCoverage,
    ARCHIVE_HEAD_VERSIONS, ARCHIVE_CRC_RE, ARCHIVE_ANCHOR_ROW_LIMIT,
    ARCHIVE_ANCHOR_BY_CONTENT_SQL, validateArchiveAnchorParams, selectArchiveHeadRow,
    presentChunkIndexes, buildArchiveAnchorResponse,
    validateAnchorActionParams, selectAnchorRow, buildAnchorActionResponse,
    ANCHOR_BY_TXID_SQL, ANCHOR_BY_TXID_AFTER_SQL,
    validateAnchorConfirmationsParams, buildAnchorConfirmationsResponse
};
