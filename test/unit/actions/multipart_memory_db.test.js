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

const assert = require('assert');
const { createMemoryMultipartDb } = require('../../helpers/multipart_memory_db');

const FILE_HASH = 'a'.repeat(64);
const OTHER_HASH = 'b'.repeat(64);
const SOURCE = 'source-a';

function manifest(actionIndex, overrides={}){
    return {
        action_index: actionIndex,
        source: SOURCE,
        file_hash: FILE_HASH,
        total_parts: 3,
        total_bytes: 30,
        status: 'valid',
        ...overrides,
    };
}

function part(actionIndex, partIndex, overrides={}){
    return {
        action_index: actionIndex,
        source: SOURCE,
        file_hash: FILE_HASH,
        part_index: partIndex,
        byte_length: 10,
        part_digest: String(partIndex).repeat(64),
        status: 'valid',
        ...overrides,
    };
}

describe('multipart memory db', function(){
    it('selects the lowest valid manifest and part per position', async function(){
        const db = createMemoryMultipartDb();

        await db.createManifest(manifest(20));
        await db.createManifest(manifest(10));
        await db.createManifest(manifest(5, { status: 'invalid: FILE_HASH (duplicate manifest)' }));

        await db.createPart(part(40, 2));
        await db.createPart(part(35, 1, { source: 'source-b' }));
        await db.createPart(part(30, 1, { file_hash: OTHER_HASH }));
        await db.createPart(part(25, 1, { status: 'invalid: RAW_DATA (empty part)' }));
        await db.createPart(part(22, 1, { part_digest: 'd'.repeat(64) }));
        await db.createPart(part(21, 1, { part_digest: 'c'.repeat(64) }));
        await db.createPart(part(15, 0));

        assert.deepStrictEqual(await db.getGroup(SOURCE, FILE_HASH), {
            manifest: {
                action_index: 10,
                file_hash: FILE_HASH,
                total_parts: 3,
                total_bytes: 30,
            },
            parts: [
                { part_index: 0, action_index: 15, byte_length: 10, part_digest: '0'.repeat(64) },
                { part_index: 1, action_index: 21, byte_length: 10, part_digest: 'c'.repeat(64) },
                { part_index: 2, action_index: 40, byte_length: 10, part_digest: '2'.repeat(64) },
            ],
        });

        assert.deepStrictEqual(await db.getGroup(SOURCE, OTHER_HASH), {
            manifest: null,
            parts: [
                { part_index: 1, action_index: 30, byte_length: 10, part_digest: '1'.repeat(64) },
            ],
        });
    });

    it('purges higher action-scoped rows while retaining lower rows', async function(){
        const db = createMemoryMultipartDb();
        const completion = {
            action_index: 13,
            manifest_action_index: 10,
            result: 'complete',
            block_index: 7,
        };

        await db.createManifest(manifest(10));
        await db.createManifest(manifest(14, { file_hash: OTHER_HASH }));
        await db.createPart(part(11, 0));
        await db.createPart(part(12, 1));
        await db.createCompletion(completion);

        assert.deepStrictEqual(await db.getCompletion(10), completion);
        await db.purgeAbove(11);

        assert.deepStrictEqual(await db.getGroup(SOURCE, FILE_HASH), {
            manifest: {
                action_index: 10,
                file_hash: FILE_HASH,
                total_parts: 3,
                total_bytes: 30,
            },
            parts: [
                { part_index: 0, action_index: 11, byte_length: 10, part_digest: '0'.repeat(64) },
            ],
        });
        assert.deepStrictEqual(await db.getGroup(SOURCE, OTHER_HASH), { manifest: null, parts: [] });
        assert.strictEqual(await db.getCompletion(10), null);
        assert.deepStrictEqual(db.calls, [
            'createManifest',
            'createManifest',
            'createPart',
            'createPart',
            'createCompletion',
            'getCompletion',
            'purgeAbove',
            'getGroup',
            'getGroup',
            'getCompletion',
        ]);
    });
});
