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
 ********************************************************************/

'use strict';

const { canonicalBatchCrc } = require('../v3_canonical.js');

const ARCHIVE_FIELDS = [
    'MATCH_BATCH_SEQ', 'MATCH_COUNT', 'BATCH_CRC32', 'TOTAL_CHUNKS', 'ARCHIVE_B64'
];

const WRAPPER_FIELDS = ['MATCH_COUNT', 'BATCH_CRC32', 'TOTAL_CHUNKS'];

const CHAIN_FIELDS = [
    'CHAIN', 'BLOCK_INDEX_CHECKPOINTED', 'BLOCK_HASH', 'LEDGER_HASH',
    'ACTIONS_HASH', 'CONTRACT_HASH', 'CHECKPOINT_SEQ', 'STATE_ROOT',
    'STATE_ROOT_VERSION', 'BLOCK_MERKLE_ROOT', 'BLOCK_MERKLE_VERSION'
];

function chainRow(data, section, sectionIndex, archive){
    let wraps = archive !== null && Number(archive.WRAPPER_SECTION_INDEX) === sectionIndex;
    let row = Object.assign({}, data, section, {
        SECTION_INDEX: sectionIndex,
        VALIDATOR_SIGNATURES: JSON.stringify(section.SIGS),
        FORMAT: data.FORMAT,
        STATUS: data.STATUS,
        MATCH_BATCH_SEQ: null,
        MATCH_COUNT: null,
        BATCH_CRC32: null,
        TOTAL_CHUNKS: null,
        CHUNK_INDEX: null,
        ARCHIVE_B64: null
    });
    if(wraps){
        for(let field of WRAPPER_FIELDS) row[field] = archive[field];
        row.BATCH_CRC32 = canonicalBatchCrc(archive.BATCH_CRC32);
    }
    delete row.SIGS;
    return row;
}

function archiveRow(data, sections, archive, wrapperSigs){
    let row = Object.assign({}, data, {
        SECTION_INDEX: sections.length,
        CHUNK_INDEX: 0,
        VALIDATOR_SIGNATURES: JSON.stringify(wrapperSigs)
    });
    for(let field of ARCHIVE_FIELDS) row[field] = archive[field];
    for(let field of CHAIN_FIELDS) row[field] = null;
    return row;
}

function foldActionRows(data, sections, archive, wrapperSigs){
    if(sections.length === 0 && archive === null)
        return [Object.assign({}, data, { SECTION_INDEX: 0 })];

    let rows = sections.map((section, index) => chainRow(data, section, index, archive));
    if(archive !== null) rows.push(archiveRow(data, sections, archive, wrapperSigs));
    return rows;
}

module.exports = { foldActionRows };
