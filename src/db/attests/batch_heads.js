/*********************************************************************
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 **********************************************************************
 * XChain Indexer - Database mixin part: complete ATTEST batch heads.
 ********************************************************************/

'use strict';

// The ATTEST batch wire versions, taken from the codec rather than written as literals
// here, so this completeness read and the parser cannot disagree about which versions
// are a batch head and its chunks.
const abw = require('../../actions/attest/attest_batch_wire.js');

module.exports = {
    async getCompleteAttestBatchesByWindowStart(windowStartFrom, windowStartTo, limit) {
        let query = `SELECT h.batch_window_start, h.batch_window_end, h.batch_row_count,
                            h.action_index, h.block_index, it.hash AS tx_hash
                     FROM attests h
                     JOIN index_statuses hs ON hs.id = h.status_id
                     LEFT JOIN actions ha ON ha.action_index = h.action_index
                     LEFT JOIN transactions ht ON ht.tx_index = ha.tx_index
                     LEFT JOIN index_transactions it ON it.id = ht.tx_hash_id
                     WHERE h.version = ${abw.ATTEST_BATCH_HEAD_VERSION}
                       AND hs.status = 'valid'
                       AND h.batch_window_start BETWEEN ? AND ?
                       AND h.batch_total_chunks IS NOT NULL
                       AND h.batch_total_chunks >= 1
                       AND (
                           h.batch_total_chunks = 1
                           OR (
                               ha.source_id IS NOT NULL
                               AND (
                                   SELECT COUNT(DISTINCT c.batch_chunk_index)
                                   FROM attests c
                                   JOIN index_statuses cs ON cs.id = c.status_id
                                   LEFT JOIN actions ca ON ca.action_index = c.action_index
                                   WHERE c.request_id = h.request_id
                                     AND c.version IN (${abw.ATTEST_BATCH_HEAD_VERSION}, ${abw.ATTEST_BATCH_CONTINUATION_VERSION})
                                     AND cs.status = 'valid'
                                     AND ca.source_id = ha.source_id
                                     AND c.batch_total_chunks = h.batch_total_chunks
                                     AND c.batch_crc32 = h.batch_crc32
                                     AND c.batch_chunk_index >= 0
                                     AND c.batch_chunk_index < h.batch_total_chunks
                               ) = h.batch_total_chunks
                           )
                       )
                     ORDER BY h.batch_window_start ASC, h.action_index ASC
                     LIMIT ?`;
        return await this.doQuery(query, [windowStartFrom, windowStartTo, limit]);
    },
};
