/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 **********************************************************************
 * test/helpers/file_multipart_column_stub.js
 */

'use strict';

const UINT32_MAX = 4294967295;

function assertChar64(column, value, exact){
    if(typeof value !== 'string' || (exact ? value.length !== 64 : value.length > 64))
        throw new Error(column + ' is not a valid CHAR(64) value');
}

function assertUint32(column, value){
    if(!Number.isInteger(value) || value < 0 || value > UINT32_MAX)
        throw new Error(column + ' is not a valid INT UNSIGNED value');
}

function assertSafeUint(column, value){
    if(!Number.isSafeInteger(value) || value < 0)
        throw new Error(column + ' is not a valid BIGINT UNSIGNED value');
}

function assertManifestRow(row){
    assertChar64('file_hash', row.file_hash, false);
    assertUint32('total_parts', row.total_parts);
    assertSafeUint('total_bytes', row.total_bytes);
    return row;
}

function assertPartRow(row){
    assertChar64('file_hash', row.file_hash, false);
    assertUint32('part_index', row.part_index);
    assertUint32('byte_length', row.byte_length);
    assertChar64('part_digest', row.part_digest, true);
    return row;
}

function assertCompletionRow(row){
    assertUint32('manifest_action_index', row.manifest_action_index);
    if(row.result !== 'complete' && row.result !== 'mismatch')
        throw new Error('result is not a valid completion result');
    assertUint32('action_index', row.action_index);
    return row;
}

function makeColumnRejectingDb(){
    const manifests = [];
    const parts = [];
    const completions = [];

    return {
        async createManifest(row){
            manifests.push(assertManifestRow(row));
        },
        async createPart(row){
            parts.push(assertPartRow(row));
        },
        async createCompletion(row){
            completions.push(assertCompletionRow(row));
        },
        manifests,
        parts,
        completions,
    };
}

module.exports = { assertManifestRow, assertPartRow, makeColumnRejectingDb };
