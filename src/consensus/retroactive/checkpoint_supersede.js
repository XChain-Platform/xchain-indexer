/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * Pure checkpoint supersession canonicalization and lookup rules.
 *
 ********************************************************************/

'use strict';

function supersedeSuffix(checkpoint){
    const hasFrom = checkpoint.supersedes_from !== null && checkpoint.supersedes_from !== undefined;
    const hasDigest = checkpoint.rules_digest !== null && checkpoint.rules_digest !== undefined;
    if(!hasFrom && !hasDigest) return '';
    if(hasFrom !== hasDigest) throw new TypeError('supersedes_from and rules_digest must appear together');

    const from = Number(checkpoint.supersedes_from);
    if(!Number.isSafeInteger(from) || from < 0)
        throw new TypeError('supersedes_from must be a non-negative safe integer');
    if(typeof checkpoint.rules_digest !== 'string' || !/^[0-9a-f]{64}$/i.test(checkpoint.rules_digest))
        throw new TypeError('rules_digest must be 64 hexadecimal characters');

    return '|SUPERSEDE|' + from + '|' + checkpoint.rules_digest.toLowerCase();
}

function supersededBySeq(row, rows){
    const rowSeq = Number(row.checkpoint_seq);
    const blockIndex = Number(row.block_index);
    let lowest = null;
    for(const candidate of rows){
        if(candidate.chain !== row.chain || candidate.network !== row.network) continue;
        if(candidate.supersedes_from === null || candidate.supersedes_from === undefined) continue;
        const candidateSeq = Number(candidate.checkpoint_seq);
        const supersedesFrom = Number(candidate.supersedes_from);
        if(candidateSeq > rowSeq && supersedesFrom <= blockIndex &&
           (lowest === null || candidateSeq < lowest)) lowest = candidateSeq;
    }
    return lowest;
}

module.exports = { supersedeSuffix, supersededBySeq };
