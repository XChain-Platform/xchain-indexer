// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const SEP = String.fromCharCode(124);

// Embed the batch CRC32 lower-case; every ANCHOR archive canonical builder calls this.
function canonicalBatchCrc(crc){
    return String(crc).toLowerCase();
}

function archiveCanonicalSuffix(archive){
    return [String(archive.MATCH_BATCH_SEQ), String(archive.MATCH_COUNT), canonicalBatchCrc(archive.BATCH_CRC32),
            String(archive.TOTAL_CHUNKS)].map(value => SEP + value).join('');
}

function signsExtendedCanonical(sectionIndex, archive){
    return archive != null &&
           Number(archive.WRAPPER_SECTION_INDEX) === Number(sectionIndex);
}

function extendSectionCanonicalBase(base, sectionIndex, archive){
    return signsExtendedCanonical(sectionIndex, archive)
        ? base + archiveCanonicalSuffix(archive)
        : base;
}

module.exports = {
    canonicalBatchCrc,
    archiveCanonicalSuffix,
    signsExtendedCanonical,
    extendSectionCanonicalBase,
};
