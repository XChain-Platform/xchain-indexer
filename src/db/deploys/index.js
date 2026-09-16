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
 * XChain Indexer - Database mixin: deploys
 * 
 * The queries over the deploys table family in src/sql/. Installed onto Database.prototype by
 * db/index.js, so call sites stay this.db.<method>().
 *
 ********************************************************************/

module.exports = {

    // Record one DEPLOY v4 carrier (a base64 slice of a chunked contract's source). Upsert keyed
    // on the action_index (the rollback key) - mirrors createContract. Every chunk is stored
    // with its status (valid/invalid) so the explorer can surface it; the DEPLOY assembler
    // (getDeployChunksForAssembly) reads only the VALID rows.
    async recordDeployChunk(data){
        data             = this.normalizeDataValues(data);
        let status_id    = await this.createStatus(data['STATUS']);
        let source_id    = await this.getAddressId(data['SOURCE']);
        let action_index = data['ACTION_INDEX'];
        let code_hash    = data['CODE_HASH'];
        let chunk_index  = Number(data['CHUNK_INDEX']);
        let total_chunks = Number(data['TOTAL_CHUNKS']);
        let code_part    = data['CODE_PART'];
        let block_index  = data['BLOCK_INDEX'];
        let query   = "SELECT action_index FROM deploy_chunks WHERE action_index=? LIMIT 1";
        let results = await this.doQuery(query, [action_index]);
        if(results.length > 0){
            query = `UPDATE deploy_chunks SET
                        source_id=?, code_hash=?, chunk_index=?, total_chunks=?, code_part=?, block_index=?, status_id=?
                     WHERE action_index=?`;
        } else {
            query = `INSERT INTO deploy_chunks
                        (source_id, code_hash, chunk_index, total_chunks, code_part, block_index, status_id, action_index)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
        }
        await this.doQuery(query, [source_id, code_hash, chunk_index, total_chunks, code_part, block_index, status_id, action_index]);
    },

    // Gather the VALID chunk parts a chunked DEPLOY (v2/v3) may assemble: same deployer
    // (source), same code_hash group, recorded at a LOWER action_index than the assembling
    // DEPLOY (so a DEPLOY only ever consumes chunks that precede it - any reorg removing a
    // chunk also removes the dependent DEPLOY, keeping rollback trivial). Ordered by
    // chunk_index then action_index so a duplicated position deterministically resolves to
    // its first submission on every node. Returns raw rows; deploy.js does the contiguity +
    // sha256 assembly check.
    async getDeployChunksForAssembly(source, codeHash, beforeActionIndex){
        let source_id = await this.getAddressId(source);
        if(source_id === null) return [];
        let query = `SELECT dc.chunk_index, dc.total_chunks, dc.code_part, dc.action_index
                     FROM deploy_chunks dc
                     INNER JOIN index_statuses s ON (s.id=dc.status_id)
                     WHERE dc.source_id=? AND dc.code_hash=? AND dc.action_index < ? AND s.status='valid'
                     ORDER BY dc.chunk_index ASC, dc.action_index ASC`;
        return await this.doQuery(query, [source_id, codeHash, beforeActionIndex]);
    },

};
