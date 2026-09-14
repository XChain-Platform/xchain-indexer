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
 * XChain Indexer - Database mixin part: attests / batch_chunks
 *
 * The ATTEST batch chunk-table read, and the verdict stamp a failed reassembly leaves
 * on the batch head.
 * Merged into the attests mixin by db/attests.js, which db/index.js installs
 * onto Database.prototype, so call sites stay this.db.<method>().
 *
 ********************************************************************/

// The ATTEST batch wire versions, taken from the codec rather than written as literals
// here, so the chunk read and the parser cannot disagree about which versions are chunks.
const abw = require('../../actions/attest/attest_batch_wire.js');
// Module-level state and pure helpers that the split keeps in one place, so the class
// and every mixin read the same instance of each.
const { ATTEST_BATCH_CHUNK_ROW_LIMIT } = require('../shared.js');

module.exports = {

    // The stored chunk table for one ATTEST batch: the v5 head's slot 0 and every v6
    // continuation slot already on chain, under the batch key both file themselves by.
    //
    // Rejected rows are excluded, so a junk wire can neither occupy a slot nor contribute
    // bytes, and an unstamped row (a structurally broken wire, or a row written before
    // these columns existed) is excluded too: it carries no slot, so it is not a chunk.
    // The head row carries the window header as well, which is what lets a continuation
    // landing afterwards rebuild the head it must verify the reassembled body against.
    //
    // `source` is the broadcaster address off actions.source_id, which is the only
    // authenticated identity a chain wire carries and is what binds a slot to a publisher.
    // The key is derived from the window a head declares, so anyone can mint a wire under
    // it and the unscoped set this returns is every publisher's; attest.js partitions it
    // by author (the ARCHIVE_CHUNK_SET_BY_AUTHOR_SQL rule, applied there because that is
    // where the rest of the batch's rules live and are driven).
    //
    // `author`, when supplied, moves that partition INTO the query, exactly as
    // getAnchorChunks takes the archive rail's, and is the only form that can carry a row
    // limit. THE LIMIT BELONGS AFTER THE PARTITION, NEVER BEFORE IT: a batch key is
    // sha256 over the window it names, so anyone can derive it and mint wires under it
    // ahead of the honest publisher, and the order here is slot-major, so a limit taken
    // before the partition is emptied by junk filling the low slots and the honest
    // publisher's own head and chunks fall outside the window. That is the reverse of the
    // archive rail's content-addressed read, where a copy is made from bytes already
    // on-chain and so can never sort ahead of the original it copied. After the partition
    // the bound is free: one publisher's valid rows under one key are their head plus one
    // row per slot (a second head and a refilled slot are both stamped invalid, and this
    // query returns only 'valid'), which the wire geometry ceiling already bounds.
    //
    // ORDER BY slot then action_index makes the head pick and the duplicate resolution
    // deterministic across nodes: within a slot the EARLIEST action wins, matching
    // attestChunkCoverage's own tie-break. Ordering is on consensus-visible columns only,
    // never on a local auto-increment.
    //
    // @param {string} batchKey the 64-hex batch key (attests.request_id on a batch row)
    // @param {string} [author] broadcaster address to scope to; omitted returns every
    //                          publisher's rows unbounded, the legacy shape
    // @returns {Object[]} rows shaped for attest_batch_wire's coverage and reassembly
    async getAttestBatchChunks(batchKey, author){
        let scoped = (author !== undefined && author !== null && String(author).length > 0);
        let query = `SELECT c.action_index, c.version, c.request_id,
                            c.batch_window_start     AS window_start,
                            c.batch_window_end       AS window_end,
                            c.batch_row_count        AS row_count,
                            c.batch_btc_block_height AS btc_block_height,
                            c.batch_crc32            AS batch_crc32,
                            c.batch_total_chunks     AS total_chunks,
                            c.batch_chunk_index      AS chunk_index,
                            c.batch_chunk_b64        AS chunk_b64,
                            cadr.address             AS source
                     FROM attests c
                     JOIN index_statuses s ON s.id = c.status_id
                     LEFT JOIN actions         cact ON cact.action_index = c.action_index
                     LEFT JOIN index_addresses cadr ON cadr.id           = cact.source_id
                     WHERE c.request_id = ?
                       AND c.version IN (${abw.ATTEST_BATCH_HEAD_VERSION}, ${abw.ATTEST_BATCH_CONTINUATION_VERSION})
                       AND c.batch_chunk_index IS NOT NULL
                       AND s.status = 'valid'` +
                     (scoped ? ` AND cadr.address = ?` : ``) + `
                     ORDER BY c.batch_chunk_index ASC, c.action_index ASC` +
                     (scoped ? ` LIMIT ${ATTEST_BATCH_CHUNK_ROW_LIMIT}` : ``);
        let params = [String(batchKey || '').toLowerCase()];
        if(scoped) params.push(String(author));
        return await this.doQuery(query, params);
    },

    // Stamp a verdict on a batch HEAD row after the fact, the ANCHOR archive rule
    // (setAnchorArchiveStatus): when a continuation completes the coverage and the
    // reassembled body fails, the failure belongs to the batch, and the batch's verdict
    // lives on its head. The completing chunk's own bytes were well formed and its row
    // stays valid, so one bad batch never re-judges an honest wire.
    async setAttestBatchStatus(actionIndex, status){
        let status_id = await this.createStatus(status);
        await this.doQuery("UPDATE attests SET status_id = ? WHERE action_index = ?", [status_id, actionIndex]);
    },

};
