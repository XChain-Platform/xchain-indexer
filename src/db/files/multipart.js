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
        const hasFilled = Object.prototype.hasOwnProperty.call(data, 'FILLED_AT_MANIFEST');
        if(!hasFilled){
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
        }
        const query = `INSERT INTO file_manifests
                           (action_index, source_id, file_hash, total_parts, total_bytes, status_id,
                            filled_at_manifest)
                       VALUES (?, ?, ?, ?, ?, ?, ?)
                       ON DUPLICATE KEY UPDATE
                           source_id=VALUES(source_id), file_hash=VALUES(file_hash),
                           total_parts=VALUES(total_parts), total_bytes=VALUES(total_bytes),
                           status_id=VALUES(status_id),
                           filled_at_manifest=VALUES(filled_at_manifest)`;
        return this.doQuery(query, [
            data['ACTION_INDEX'], source_id, data['FILE_HASH'], Number(data['TOTAL_PARTS']),
            Number(data['TOTAL_BYTES']), status_id,
            data['FILLED_AT_MANIFEST'] === null ? null : Number(data['FILLED_AT_MANIFEST'])
        ]);
    },

    async createPart(data){
        data = this.normalizeDataValues(data);
        const source_id = await this.getAddressId(data['SOURCE']);
        const status_id = await this.createStatus(data['STATUS']);
        const hasOrdinal = Object.prototype.hasOwnProperty.call(data, 'FILL_ORDINAL');
        if(!hasOrdinal){
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
        }
        const query = `INSERT INTO file_parts
                           (action_index, source_id, file_hash, part_index, byte_length,
                            part_digest, block_index, status_id, fill_ordinal)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                       ON DUPLICATE KEY UPDATE
                           source_id=VALUES(source_id), file_hash=VALUES(file_hash),
                           part_index=VALUES(part_index), byte_length=VALUES(byte_length),
                           part_digest=VALUES(part_digest), block_index=VALUES(block_index),
                           status_id=VALUES(status_id), fill_ordinal=VALUES(fill_ordinal)`;
        return this.doQuery(query, [
            data['ACTION_INDEX'], source_id, data['FILE_HASH'], Number(data['PART_INDEX']),
            Number(data['BYTE_LENGTH']), data['PART_DIGEST'], data['BLOCK_INDEX'], status_id,
            data['FILL_ORDINAL'] === null ? null : Number(data['FILL_ORDINAL'])
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

    async getManifest(source, fileHash){
        const source_id = await this.getAddressId(source);
        if(source_id === null) return null;

        const query = `SELECT fm.action_index, fm.source_id, fm.file_hash,
                              fm.total_parts, fm.total_bytes, fm.filled_at_manifest
                       FROM file_manifests fm
                       INNER JOIN index_statuses s ON (s.id=fm.status_id)
                       WHERE fm.source_id=? AND fm.file_hash=? AND s.status='valid'
                       ORDER BY fm.action_index ASC
                       LIMIT 1`;
        const rows = await this.doQuery(query, [source_id, fileHash]);
        return rows[0] || null;
    },

    async earlierPartAt(sourceId, fileHash, partIndex){
        const query = `SELECT fp.action_index
                       FROM file_parts fp
                       INNER JOIN index_statuses s ON (s.id=fp.status_id)
                       WHERE fp.source_id=? AND fp.file_hash=? AND fp.part_index=?
                         AND s.status='valid'
                       ORDER BY fp.action_index ASC
                       LIMIT 1`;
        const rows = await this.doQuery(query, [sourceId, fileHash, partIndex]);
        return rows[0] || null;
    },

    async maxFillOrdinal(sourceId, fileHash){
        const query = `SELECT MAX(fill_ordinal) AS max_fill_ordinal
                       FROM file_parts
                       WHERE source_id=? AND file_hash=?`;
        const rows = await this.doQuery(query, [sourceId, fileHash]);
        return Number(rows[0] && rows[0].max_fill_ordinal) || 0;
    },

    async countFilledPositions(sourceId, fileHash, totalParts){
        const query = `SELECT COUNT(DISTINCT fp.part_index) AS filled_positions
                       FROM file_parts fp
                       INNER JOIN index_statuses s ON (s.id=fp.status_id)
                       WHERE fp.source_id=? AND fp.file_hash=? AND fp.part_index < ?
                         AND s.status='valid'`;
        const rows = await this.doQuery(query, [sourceId, fileHash, totalParts]);
        return Number(rows[0] && rows[0].filled_positions) || 0;
    },

    async getGroup(source, fileHash){
        const manifest = await this.getManifest(source, fileHash);
        if(!manifest) return { manifest: null, parts: [] };

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
        const parts = await this.doQuery(partsQuery, [
            manifest.source_id, fileHash, Number(manifest.total_parts)
        ]);
        return { manifest, parts };
    },

};
