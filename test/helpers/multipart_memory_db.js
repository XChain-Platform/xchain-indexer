/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 ********************************************************************/
'use strict';

function createMemoryMultipartDb(){
    let manifests = [];
    let parts = [];
    let completions = [];
    const calls = [];
    let readCount = 0;

    function value(row, lower, upper){
        return Object.prototype.hasOwnProperty.call(row, lower) ? row[lower] : row[upper];
    }

    function normalized(row){
        return {
            ...row,
            action_index: value(row, 'action_index', 'ACTION_INDEX'),
            source: value(row, 'source', 'SOURCE'),
            file_hash: value(row, 'file_hash', 'FILE_HASH'),
            total_parts: value(row, 'total_parts', 'TOTAL_PARTS'),
            total_bytes: value(row, 'total_bytes', 'TOTAL_BYTES'),
            part_index: value(row, 'part_index', 'PART_INDEX'),
            byte_length: value(row, 'byte_length', 'BYTE_LENGTH'),
            part_digest: value(row, 'part_digest', 'PART_DIGEST'),
            status: value(row, 'status', 'STATUS'),
            block_index: value(row, 'block_index', 'BLOCK_INDEX'),
            manifest_action_index: value(row, 'manifest_action_index', 'MANIFEST_ACTION_INDEX'),
            result: value(row, 'result', 'RESULT'),
            filled_at_manifest: value(row, 'filled_at_manifest', 'FILLED_AT_MANIFEST'),
            fill_ordinal: value(row, 'fill_ordinal', 'FILL_ORDINAL'),
        };
    }

    function read(name){
        calls.push(name);
        readCount += 1;
    }

    function validManifest(source, fileHash){
        return manifests
            .filter(row => row.status === 'valid' && row.source === source && row.file_hash === fileHash)
            .sort((a, b) => a.action_index - b.action_index)[0] || null;
    }

    return {
        async createManifest(row){
            calls.push('createManifest');
            manifests.push(normalized(row));
        },

        async createPart(row){
            calls.push('createPart');
            parts.push(normalized(row));
        },

        async createCompletion(row){
            calls.push('createCompletion');
            const item = normalized(row);
            completions.push({
                action_index: item.action_index,
                manifest_action_index: item.manifest_action_index,
                result: item.result,
                block_index: item.block_index,
            });
        },

        async getAddressId(source){
            return source;
        },

        async getGroup(source, fileHash){
            read('getGroup');
            const manifestRow = validManifest(source, fileHash);

            const winningParts = new Map();
            for(const row of parts){
                if(row.status !== 'valid' || row.source !== source || row.file_hash !== fileHash)
                    continue;
                const winner = winningParts.get(row.part_index);
                if(!winner || row.action_index < winner.action_index)
                    winningParts.set(row.part_index, row);
            }

            return {
                manifest: manifestRow ? {
                    action_index: manifestRow.action_index,
                    file_hash: manifestRow.file_hash,
                    total_parts: manifestRow.total_parts,
                    total_bytes: manifestRow.total_bytes,
                } : null,
                parts: Array.from(winningParts.values())
                    .sort((a, b) => a.part_index - b.part_index)
                    .map(row => ({
                        part_index: row.part_index,
                        action_index: row.action_index,
                        byte_length: row.byte_length,
                        part_digest: row.part_digest,
                    })),
            };
        },

        async getManifest(source, fileHash){
            read('getManifest');
            const row = validManifest(source, fileHash);
            return row ? {
                action_index: row.action_index,
                source_id: row.source,
                file_hash: row.file_hash,
                total_parts: row.total_parts,
                total_bytes: row.total_bytes,
                filled_at_manifest: row.filled_at_manifest,
            } : null;
        },

        async earlierPartAt(sourceId, fileHash, partIndex){
            read('earlierPartAt');
            const row = parts
                .filter(item => item.status === 'valid' && item.source === sourceId &&
                    item.file_hash === fileHash && Number(item.part_index) === Number(partIndex))
                .sort((a, b) => a.action_index - b.action_index)[0];
            return row ? { action_index: row.action_index } : null;
        },

        async maxFillOrdinal(sourceId, fileHash){
            read('maxFillOrdinal');
            return parts
                .filter(row => row.source === sourceId && row.file_hash === fileHash)
                .reduce((max, row) => Math.max(max, Number(row.fill_ordinal) || 0), 0);
        },

        async countFilledPositions(sourceId, fileHash, totalParts){
            read('countFilledPositions');
            return new Set(parts
                .filter(row => row.status === 'valid' && row.source === sourceId &&
                    row.file_hash === fileHash && Number(row.part_index) < Number(totalParts))
                .map(row => Number(row.part_index))).size;
        },

        async getCompletion(manifestActionIndex){
            read('getCompletion');
            const row = completions.find(item => item.manifest_action_index === manifestActionIndex);
            return row ? { ...row } : null;
        },

        async purgeAbove(actionIndex){
            calls.push('purgeAbove');
            manifests = manifests.filter(row => row.action_index <= actionIndex);
            parts = parts.filter(row => row.action_index <= actionIndex);
            completions = completions.filter(row => row.action_index <= actionIndex);
        },

        resetReadCount(){
            readCount = 0;
        },

        calls,
        get readCount(){ return readCount; },
        get completionRows(){ return completions.map(row => ({ ...row })); },
    };
}

module.exports = { createMemoryMultipartDb };
