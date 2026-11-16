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
 ********************************************************************/

'use strict';

module.exports = {

    async createManifest(data){
        data = this.normalizeDataValues(data);
        const source_id = await this.getAddressId(data['SOURCE']);
        const status_id = await this.createStatus(data['STATUS']);
        const query = `INSERT INTO file_manifests
                           (action_index, source_id, file_hash, total_parts, total_bytes, status_id)
                       VALUES (?, ?, ?, ?, ?, ?)
                       ON DUPLICATE KEY UPDATE
                           source_id=VALUES(source_id), file_hash=VALUES(file_hash),
                           total_parts=VALUES(total_parts), total_bytes=VALUES(total_bytes),
                           status_id=VALUES(status_id)`;
        return this.doQuery(query, [
            data['ACTION_INDEX'], source_id, data['FILE_HASH'], Number(data['TOTAL_PARTS']),
            Number(data['TOTAL_BYTES']), status_id
        ]);
    },

    async createPart(data){
        data = this.normalizeDataValues(data);
        const source_id = await this.getAddressId(data['SOURCE']);
        const status_id = await this.createStatus(data['STATUS']);
        const query = `INSERT INTO file_parts
                           (action_index, source_id, file_hash, part_index, byte_length,
                            part_digest, block_index, status_id)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                       ON DUPLICATE KEY UPDATE
                           source_id=VALUES(source_id), file_hash=VALUES(file_hash),
                           part_index=VALUES(part_index), byte_length=VALUES(byte_length),
                           part_digest=VALUES(part_digest), block_index=VALUES(block_index),
                           status_id=VALUES(status_id)`;
        return this.doQuery(query, [
            data['ACTION_INDEX'], source_id, data['FILE_HASH'], Number(data['PART_INDEX']),
            Number(data['BYTE_LENGTH']), data['PART_DIGEST'], data['BLOCK_INDEX'], status_id
        ]);
    },

    async createCompletion(data){
        data = this.normalizeDataValues(data);
        const query = `INSERT INTO file_completions
                           (action_index, manifest_action_index, result, block_index)
                       VALUES (?, ?, ?, ?)
                       ON DUPLICATE KEY UPDATE
                           manifest_action_index=VALUES(manifest_action_index),
                           result=VALUES(result), block_index=VALUES(block_index)`;
        return this.doQuery(query, [
            data['ACTION_INDEX'], data['MANIFEST_ACTION_INDEX'], data['RESULT'], data['BLOCK_INDEX']
        ]);
    },

    async getGroup(source, fileHash){
        const source_id = await this.getAddressId(source);
        if(source_id === null) return { manifest: null, parts: [] };

        const manifestQuery = `SELECT fm.action_index, fm.source_id, fm.file_hash,
                                      fm.total_parts, fm.total_bytes
                               FROM file_manifests fm
                               INNER JOIN index_statuses s ON (s.id=fm.status_id)
                               WHERE fm.source_id=? AND fm.file_hash=? AND s.status='valid'
                               ORDER BY fm.action_index ASC
                               LIMIT 1`;
        const manifests = await this.doQuery(manifestQuery, [source_id, fileHash]);

        const partsQuery = `SELECT fp.action_index, fp.source_id, fp.file_hash, fp.part_index,
                                   fp.byte_length, fp.part_digest, fp.block_index
                            FROM file_parts fp
                            INNER JOIN (
                                SELECT p.part_index, MIN(p.action_index) AS action_index
                                FROM file_parts p
                                INNER JOIN index_statuses s ON (s.id=p.status_id)
                                WHERE p.source_id=? AND p.file_hash=? AND p.part_index < ?
                                  AND s.status='valid'
                                GROUP BY p.part_index
                            ) first_parts ON (first_parts.action_index=fp.action_index)
                            ORDER BY fp.part_index ASC, fp.action_index ASC`;
        const partLimit = manifests.length > 0 ? Number(manifests[0].total_parts) : 32;
        const parts = await this.doQuery(partsQuery, [source_id, fileHash, partLimit]);
        return { manifest: manifests[0] || null, parts };
    },

};
