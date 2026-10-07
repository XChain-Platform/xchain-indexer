// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict';

const {
    ARCHIVE_REISSUE_RETRY_REASON,
    classifyArchiveReissue
} = require('./archive_reissue.js');

async function archiveReissueRefusal(db, incoming) {
    if (!incoming || typeof incoming.author !== 'string' || incoming.author.length === 0 ||
        !Number.isSafeInteger(incoming.batchSeq) || incoming.batchSeq < 0) {
        return null;
    }

    const rows = await db.getArchiveHeadsByAuthorAndSeq(incoming.author, incoming.batchSeq);
    const classification = classifyArchiveReissue(rows, {
        batch_crc32: incoming.batchCrc32,
        match_count: incoming.matchCount
    });
    return classification === 'conflict' ? ARCHIVE_REISSUE_RETRY_REASON : null;
}

module.exports = { archiveReissueRefusal };
