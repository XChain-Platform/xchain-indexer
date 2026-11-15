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

module.exports = { assemblyVerdict };
