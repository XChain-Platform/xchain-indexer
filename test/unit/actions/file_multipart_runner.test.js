// Copyright (c) 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

'use strict';

const assert = require('assert');
const vectors = require('../../fixtures/multipart_file.json').vectors;
const { createMemoryMultipartDb } = require('../../helpers/multipart_memory_db.js');
const { completeGroup } = require('../../../src/actions/file_multipart_runner.js');

const SOURCE = 'source-a';

function manifest(vector, actionIndex, overrides={}){
    return {
        action_index: actionIndex,
        source: SOURCE,
        file_hash: vector.FILE_HASH,
        total_parts: vector.TOTAL_PARTS,
        total_bytes: vector.TOTAL_BYTES,
        status: 'valid',
        ...overrides,
    };
}

function part(vector, item, actionIndex, overrides={}){
    return {
        action_index: actionIndex,
        source: SOURCE,
        file_hash: vector.FILE_HASH,
        part_index: item.PART_INDEX,
        byte_length: Buffer.from(item.hex, 'hex').length,
        part_digest: item.digest,
        status: 'valid',
        ...overrides,
    };
}

function input(vector, pieceActionIndex, blockIndex=500){
    return { source: SOURCE, fileHash: vector.FILE_HASH, pieceActionIndex, blockIndex };
}

function completionCalls(db){
    return db.calls.filter(call => call === 'createCompletion');
}

async function feedVector(vector, manifestFirst){
    const db = createMemoryMultipartDb();
    const ordered = manifestFirst
        ? [{ type: 'manifest', item: null }, ...vector.parts.map(item => ({ type: 'part', item }))]
        : [...vector.parts.toReversed().map(item => ({ type: 'part', item })), { type: 'manifest', item: null }];
    const pieces = ordered.map((piece, offset) => ({
        type: piece.type,
        row: piece.type === 'manifest'
            ? manifest(vector, 10 + offset)
            : part(vector, piece.item, 10 + offset),
    }));
    const decisions = [];
    for(const piece of pieces){
        if(piece.type === 'manifest') await db.createManifest(piece.row);
        else await db.createPart(piece.row);
        decisions.push(await completeGroup(db, input(vector, piece.row.action_index)));
    }
    return { db, decisions };
}

async function seeded(vector=vectors[0]){
    const db = createMemoryMultipartDb();
    await db.createManifest(manifest(vector, 10));
    for(const [offset, item] of vector.parts.entries())
        await db.createPart(part(vector, item, 20 + offset));
    return db;
}

describe('FILE multipart runner documentation vectors in reverse order @regression @tier1', function(){
    for(const vector of vectors){
        it('completes ' + vector.name, async function(){
            const { db, decisions } = await feedVector(vector, false);
            assert.strictEqual(decisions.at(-1).result, vector.expected);
            assert.strictEqual(decisions.filter(Boolean).length, 1);
            assert.strictEqual(completionCalls(db).length, 1);
        });
    }
});

describe('FILE multipart runner documentation vectors manifest first @regression @tier1', function(){
    for(const vector of vectors){
        it('completes ' + vector.name, async function(){
            const { db, decisions } = await feedVector(vector, true);
            assert.strictEqual(decisions.at(-1).result, vector.expected);
            assert.strictEqual(decisions.filter(Boolean).length, 1);
            assert.strictEqual(completionCalls(db).length, 1);
        });
    }
});

describe('FILE multipart runner duplicate part @regression @tier1', function(){
    it('keeps one completion from the lowest action-index part', async function(){
        const vector = vectors[0];
        const db = await seeded(vector);
        await db.createPart(part(vector, vector.parts[0], 99, { part_digest: '00'.repeat(32) }));
        const row = await completeGroup(db, input(vector, 99));
        assert.strictEqual(row.result, 'complete');
        assert.strictEqual(completionCalls(db).length, 1);
    });
});

describe('FILE multipart runner missing part @regression @tier1', function(){
    it('returns before the completion read', async function(){
        const vector = vectors[1];
        const db = createMemoryMultipartDb();
        await db.createManifest(manifest(vector, 10));
        await db.createPart(part(vector, vector.parts[0], 20));
        const before = db.calls.length;
        assert.strictEqual(await completeGroup(db, input(vector, 20)), null);
        assert.deepStrictEqual(db.calls.slice(before), ['getGroup']);
    });
});

describe('FILE multipart runner high position @regression @tier1', function(){
    it('ignores a part position above the manifest range', async function(){
        const vector = vectors[0];
        const db = await seeded(vector);
        await db.createPart(part(vector, vector.parts[0], 99, {
            part_index: vector.TOTAL_PARTS,
            byte_length: 500,
            part_digest: '00'.repeat(32),
        }));
        assert.strictEqual((await completeGroup(db, input(vector, 99))).result, 'complete');
        assert.strictEqual(completionCalls(db).length, 1);
    });
});

describe('FILE multipart runner foreign source @regression @tier1', function(){
    it('does not assemble parts from another source', async function(){
        const vector = vectors[0];
        const db = createMemoryMultipartDb();
        await db.createManifest(manifest(vector, 10));
        for(const [offset, item] of vector.parts.entries())
            await db.createPart(part(vector, item, 20 + offset, { source: 'source-b' }));
        const before = db.calls.length;
        assert.strictEqual(await completeGroup(db, input(vector, 21)), null);
        assert.deepStrictEqual(db.calls.slice(before), ['getGroup']);
    });
});

describe('FILE multipart runner duplicate manifest @regression @tier1', function(){
    it('completes once against the lowest action-index manifest', async function(){
        const vector = vectors[0];
        const db = await seeded(vector);
        await db.createManifest(manifest(vector, 50));
        const row = await completeGroup(db, input(vector, 50));
        assert.strictEqual(row.manifest_action_index, 10);
        assert.strictEqual(completionCalls(db).length, 1);
    });
});

describe('FILE multipart runner terminal mismatch @regression @tier1', function(){
    it('keeps the first mismatch terminal when a valid duplicate arrives', async function(){
        const vector = vectors[0];
        const db = await seeded(vector);
        await db.createPart(part(vector, vector.parts[0], 5, { part_digest: '00'.repeat(32) }));
        assert.strictEqual((await completeGroup(db, input(vector, 21))).result, 'mismatch');
        await db.createPart(part(vector, vector.parts[0], 4));
        assert.strictEqual(await completeGroup(db, input(vector, 22)), null);
        assert.strictEqual(completionCalls(db).length, 1);
    });
});

describe('FILE multipart runner completion replay @regression @tier1', function(){
    it('reads the existing completion and writes nothing', async function(){
        const vector = vectors[0];
        const db = await seeded(vector);
        await completeGroup(db, input(vector, 21));
        const before = db.calls.length;
        assert.strictEqual(await completeGroup(db, input(vector, 22)), null);
        assert.deepStrictEqual(db.calls.slice(before), ['getGroup', 'getCompletion']);
        assert.strictEqual(completionCalls(db).length, 1);
    });
});

describe('FILE multipart runner rollback replay @regression @tier1', function(){
    it('re-completes after purging below the last part', async function(){
        const vector = vectors[0];
        const db = await seeded(vector);
        assert.ok(await completeGroup(db, input(vector, 21)));
        await db.purgeAbove(20);
        assert.strictEqual(await completeGroup(db, input(vector, 20)), null);
        await db.createPart(part(vector, vector.parts[1], 22));
        const row = await completeGroup(db, input(vector, 22, 501));
        assert.deepStrictEqual(row, {
            action_index: 22, manifest_action_index: 10, result: 'complete', block_index: 501,
        });
        assert.strictEqual(completionCalls(db).length, 2);
    });
});
