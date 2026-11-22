/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
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

const MANIFEST_FORMAT = 'VERSION|FILE_HASH|TOTAL_PARTS|TOTAL_BYTES|NAME|TYPE|TITLE|MEMO|GATE_TICKER|ENCRYPTION_METHOD|KEY_HASH|GATE_MIN_AMOUNT|COMPRESSION';
const PART_FORMAT = 'VERSION|FILE_HASH|PART_INDEX';
const UNKNOWN_VERSION = 'invalid: VERSION (unknown)';
const DUPLICATE_MANIFEST = 'invalid: FILE_HASH (duplicate manifest)';

function multipartRoute(format, enabled, error){
    if(format === 0)
        return { route: 'legacy', error };
    if(enabled && format === 1)
        return { route: 'manifest', error };
    if(enabled && format === 2)
        return { route: 'part', error };
    return { route: 'unknown', error: error || UNKNOWN_VERSION };
}

function duplicateManifestVerdict(error, existingManifest, fileHash){
    if(!error && existingManifest !== null && existingManifest.file_hash === fileHash)
        return DUPLICATE_MANIFEST;
    return error;
}

module.exports = {
    MANIFEST_FORMAT,
    PART_FORMAT,
    multipartRoute,
    duplicateManifestVerdict,
};
