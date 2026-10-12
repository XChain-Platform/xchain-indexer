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

const SECTION_FIXED_FIELDS = 13;
const ARCHIVE_FIELD_NAMES = [
    'WRAPPER_SECTION_INDEX', 'MATCH_BATCH_SEQ', 'MATCH_COUNT',
    'BATCH_CRC32', 'TOTAL_CHUNKS', 'ARCHIVE_B64'
];

function wholeNumber(value){
    if(!/^\d+$/.test(String(value == null ? '' : value))) return null;
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : null;
}

// Preserve each section byte-for-byte while using SIG_COUNT to find its end.
function splitSections(params, sectionCount){
    const sections = [];
    let cursor = 4;
    for(let i = 0; i < sectionCount; i++){
        const sigCount = wholeNumber(params[cursor + 12]);
        if(sigCount === null)
            return { error: 'invalid: SECTION ' + i + ' SIG_COUNT' };
        const end = cursor + SECTION_FIXED_FIELDS + 2 * sigCount;
        if(end > params.length)
            return { error: 'invalid: SECTION ' + i + ' SIG_COUNT' };
        sections.push(params.slice(cursor, end));
        cursor = end;
    }
    return { sections, cursor };
}

// Require the attestation count to consume the complete remaining tail.
function splitPublisherTail(params, cursor){
    const attestCount = wholeNumber(params[cursor + 1]);
    if(attestCount === null || cursor + 2 + 2 * attestCount !== params.length)
        return null;
    return {
        PUBLISHER: params[cursor],
        attestationTail: params.slice(cursor + 1)
    };
}

function archiveObject(fields){
    return Object.fromEntries(ARCHIVE_FIELD_NAMES.map((name, index) => [name, fields[index]]));
}

function splitV3Wire(params){
    const sectionCount = wholeNumber(params[3]);
    if(sectionCount === null) return { error: 'invalid: SECTION_COUNT' };

    const split = splitSections(params, sectionCount);
    if(split.error) return { error: split.error };

    let cursor = split.cursor;
    const archiveCountToken = params[cursor++];
    if(!/^(0|1)$/.test(String(archiveCountToken == null ? '' : archiveCountToken)))
        return { error: 'invalid: ARCHIVE_COUNT' };

    const archiveCount = Number(archiveCountToken);
    const archiveFields = archiveCount === 1 ? params.slice(cursor, cursor + 6) : null;
    if(archiveCount === 1) cursor += 6;

    const tail = splitPublisherTail(params, cursor);
    if(!tail || (archiveFields && archiveFields.length !== 6))
        return { error: 'invalid: ARCHIVE_COUNT' };

    if(archiveFields){
        const wrapperIndex = wholeNumber(archiveFields[0]);
        if(wrapperIndex === null || wrapperIndex >= sectionCount)
            return { error: 'invalid: WRAPPER_SECTION_INDEX' };
    }

    return {
        header: {
            NETWORK: params[1], SNAPSHOT_BLOCK: params[2], SECTION_COUNT: params[3]
        },
        sections: split.sections,
        ARCHIVE_COUNT: archiveCountToken,
        archive: archiveFields ? archiveObject(archiveFields) : null,
        PUBLISHER: tail.PUBLISHER,
        attestationTail: tail.attestationTail
    };
}

module.exports = { splitV3Wire };
