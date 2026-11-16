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

const { assemblyVerdict } = require('./file_multipart.js');
const { decideCompletionWrite } = require('./file_multipart_decision.js');

async function completeGroup(io, { source, fileHash, pieceActionIndex, blockIndex }){
    const group = await io.getGroup(source, fileHash);
    const verdict = assemblyVerdict(group);
    if(verdict === null) return null;

    const existingCompletion = await io.getCompletion(group.manifest.action_index);
    const row = decideCompletionWrite({
        group,
        verdict,
        existingCompletion,
        pieceActionIndex,
        blockIndex,
    });
    if(row === null) return null;

    await io.createCompletion(row);
    return row;
}

module.exports = { completeGroup };
