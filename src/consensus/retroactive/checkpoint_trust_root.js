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
 * Pure refusal rule for superseded checkpoint trust roots.
 *
 ********************************************************************/

'use strict';

const { supersededBySeq } = require('./checkpoint_supersede.js');

const CHECKPOINT_SUPERSEDED = 'CHECKPOINT_SUPERSEDED';

function assertNotSuperseded(row, rows){
    const supersededBy = supersededBySeq(row, rows);
    if(supersededBy === null) return;

    const supersedingRow = rows.find((candidate) =>
        candidate.chain === row.chain &&
        candidate.network === row.network &&
        candidate.supersedes_from !== null &&
        candidate.supersedes_from !== undefined &&
        Number(candidate.checkpoint_seq) === supersededBy &&
        Number(candidate.supersedes_from) <= Number(row.block_index)
    );
    const error = new Error(
        `${row.chain}:${row.network} checkpoint_seq ${row.checkpoint_seq} ` +
        `is superseded_by_seq ${supersededBy}`
    );
    error.code = CHECKPOINT_SUPERSEDED;
    error.superseded_by_seq = supersededBy;
    error.supersedes_from = Number(supersedingRow.supersedes_from);
    throw error;
}

module.exports = { CHECKPOINT_SUPERSEDED, assertNotSuperseded };
