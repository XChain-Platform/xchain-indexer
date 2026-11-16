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

    return {
        async createManifest(row){
            calls.push('createManifest');
            manifests.push({ ...row });
        },

        async createPart(row){
            calls.push('createPart');
            parts.push({ ...row });
        },

        async createCompletion(row){
            calls.push('createCompletion');
            completions.push({ ...row });
        },

        async getGroup(source, fileHash){
            calls.push('getGroup');

            const manifestRow = manifests
                .filter(row => row.status === 'valid' && row.source === source && row.file_hash === fileHash)
                .sort((a, b) => a.action_index - b.action_index)[0];

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

        async getCompletion(manifestActionIndex){
            calls.push('getCompletion');
            const row = completions.find(item => item.manifest_action_index === manifestActionIndex);
            return row ? { ...row } : null;
        },

        async purgeAbove(actionIndex){
            calls.push('purgeAbove');
            manifests = manifests.filter(row => row.action_index <= actionIndex);
            parts = parts.filter(row => row.action_index <= actionIndex);
            completions = completions.filter(row => row.action_index <= actionIndex);
        },

        calls,
    };
}

module.exports = { createMemoryMultipartDb };
