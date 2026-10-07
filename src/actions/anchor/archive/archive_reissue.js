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
 * Same-publisher archive re-issue guard: classifies an incoming archive
 * against the rows this publisher already holds under one seq. Pure and
 * unwired; reads no DB, config or activation height.
 *
 ********************************************************************/

const ARCHIVE_REISSUE_RETRY_REASON =
    'invalid: MATCH_BATCH_SEQ (retry; this publisher already holds an archive under this seq)';

function rowMatches(row, incoming){
    if(!row || row.batch_crc32 === undefined || row.match_count === undefined) return false;
    return String(row.batch_crc32).toLowerCase() === String(incoming.batch_crc32).toLowerCase() &&
           Number(row.match_count) === Number(incoming.match_count);
}

// No stored rows means the publisher has never anchored under this seq.
// Any exact match (crc + count) is the same archive re-arriving; otherwise
// the seq is already spent on different content.
function classifyArchiveReissue(storedRows, incoming){
    if(!storedRows || storedRows.length === 0) return 'fresh';
    return storedRows.some(row => rowMatches(row, incoming)) ? 'duplicate' : 'conflict';
}

module.exports = { ARCHIVE_REISSUE_RETRY_REASON, classifyArchiveReissue };
