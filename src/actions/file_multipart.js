/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
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

const crypto = require('crypto');
const { decideCompletionWrite } = require('./file_multipart_decision.js');

const COMPLETION_QUERY = [
    'SELECT action_index, manifest_action_index, result, block_index',
    'FROM file_completions WHERE manifest_action_index=?',
    'ORDER BY action_index ASC LIMIT 1',
].join(' ');

function assemblyVerdict(group){
    if(!group || !group.manifest) return null;

    const manifest = group.manifest;
    const totalParts = Number(manifest.total_parts);
    const winners = new Map();

    for(const part of Array.isArray(group.parts) ? group.parts : []){
        const position = Number(part.part_index);
        if(!Number.isInteger(position) || position < 0 || position >= totalParts) continue;

        const winner = winners.get(position);
        if(!winner || Number(part.action_index) < Number(winner.action_index)){
            winners.set(position, part);
        }
    }

    const digest = crypto.createHash('sha256');
    let totalBytes = 0;
    for(let position = 0; position < totalParts; position += 1){
        const part = winners.get(position);
        if(!part) return null;
        digest.update(Buffer.from(part.part_digest, 'hex'));
        totalBytes += Number(part.byte_length);
    }

    return digest.digest('hex') === manifest.file_hash &&
           totalBytes === Number(manifest.total_bytes)
        ? 'complete'
        : 'mismatch';
}

function multipartIo(db){
    return {
        getGroup(source, fileHash){
            return db.getGroup(source, fileHash);
        },

        async getCompletion(manifestActionIndex){
            const rows = await db.doQuery(COMPLETION_QUERY, [manifestActionIndex]);
            return rows[0] || null;
        },

        createCompletion(row){
            return db.createCompletion({
                ACTION_INDEX: row.action_index,
                MANIFEST_ACTION_INDEX: row.manifest_action_index,
                RESULT: row.result,
                BLOCK_INDEX: row.block_index,
            });
        },
    };
}

async function completeGroup(io, piece){
    const group = await io.getGroup(piece.source, piece.fileHash);
    const verdict = assemblyVerdict(group);
    if(verdict === null) return null;

    const existingCompletion = await io.getCompletion(group.manifest.action_index);
    const row = decideCompletionWrite({
        group,
        verdict,
        existingCompletion,
        pieceActionIndex: piece.actionIndex,
        blockIndex: piece.blockIndex,
    });
    if(row === null) return null;

    await io.createCompletion(row);
    return row;
}

function completeMultipart(db, data){
    return completeGroup(multipartIo(db), {
        source: data['SOURCE'],
        fileHash: data['FILE_HASH'],
        actionIndex: data['ACTION_INDEX'],
        blockIndex: data['BLOCK_INDEX'],
    });
}

module.exports = { assemblyVerdict, completeGroup, completeMultipart, multipartIo };
