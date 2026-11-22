// Copyright (c) 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

'use strict';

const assert = require('assert');
const sinon = require('sinon');
const vectors = require('../../fixtures/multipart_file.json').vectors;
const { createMemoryMultipartDb } = require('../../helpers/multipart_memory_db.js');
const {
    buildMultipartPieces,
    multipartActionData,
} = require('../../helpers/file_multipart_pieces.js');
const { buildFile } = require('./contract/file.test/helpers/fixture.js');
const { completeGroup } = require('../../../src/actions/file_multipart.js');

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

function input(vector, actionIndex, blockIndex=500){
    return {
        source: SOURCE,
        fileHash: vector.FILE_HASH,
        actionIndex,
        blockIndex,
    };
}

function completionCalls(db){
    return db.calls.filter(call => call === 'createCompletion');
}

async function addPiece(db, piece){
    if(piece.type === 'manifest') await db.createManifest(piece.row);
    else await db.createPart(piece.row);
    return completeGroup(db, input(piece.vector, piece.row.action_index));
}

function orderedPieces(vector, manifestFirst){
    const items = manifestFirst
        ? [{ type: 'manifest' }, ...vector.parts.map(item => ({ type: 'part', item }))]
        : [...vector.parts.toReversed().map(item => ({ type: 'part', item })), { type: 'manifest' }];
    return items.map((piece, offset) => ({
        type: piece.type,
        vector,
        row: piece.type === 'manifest'
            ? manifest(vector, 10 + offset)
            : part(vector, piece.item, 10 + offset),
    }));
}

async function feedVector(vector, manifestFirst){
    const db = createMemoryMultipartDb();
    const decisions = [];
    for(const piece of orderedPieces(vector, manifestFirst))
        decisions.push(await addPiece(db, piece));
    return { db, decisions };
}

async function seeded(vector=vectors[0]){
    const db = createMemoryMultipartDb();
    await db.createManifest(manifest(vector, 10));
    for(const [offset, item] of vector.parts.entries())
        await db.createPart(part(vector, item, 20 + offset));
    return db;
}

function parserHarness(){
    const built = buildFile();
    const db = built.indexer.indexerDb;
    db.createManifest = sinon.stub().resolves();
    db.createPart = sinon.stub().resolves();
    db.createCompletion = sinon.stub().resolves();
    db.getGroup = sinon.stub();
    db.isActionAllowed = sinon.stub().resolves(true);
    db.doQuery.resolves([]);
    return { ...built, db };
}

function parserGroup(pieces, manifestIndex, partIndexes){
    return {
        manifest: {
            action_index: manifestIndex,
            file_hash: pieces.fileHash,
            total_parts: pieces.totalParts,
            total_bytes: pieces.totalBytes,
        },
        parts: pieces.parts.map((item, offset) => ({
            action_index: partIndexes[offset],
            part_index: item.partIndex,
            byte_length: item.rawData.length,
            part_digest: item.digest,
        })),
    };
}

describe('FILE multipart completion in reverse order @regression @tier1', function(){
    for(const vector of vectors){
        it('completes documentation vector ' + vector.name, async function(){
            const { db, decisions } = await feedVector(vector, false);
            assert.strictEqual(decisions.at(-1).result, vector.expected);
            assert.strictEqual(decisions.filter(Boolean).length, 1);
            assert.strictEqual(completionCalls(db).length, 1);
        });
    }
});

describe('FILE multipart completion manifest first @regression @tier1', function(){
    for(const vector of vectors){
        it('completes documentation vector ' + vector.name, async function(){
            const { db, decisions } = await feedVector(vector, true);
            assert.strictEqual(decisions.at(-1).result, vector.expected);
            assert.strictEqual(decisions.filter(Boolean).length, 1);
            assert.strictEqual(completionCalls(db).length, 1);
        });
    }
});

describe('FILE multipart completion duplicate part @regression @tier1', function(){
    it('uses the part with the lowest action index', async function(){
        const vector = vectors[0];
        const db = await seeded(vector);
        await db.createPart(part(vector, vector.parts[0], 99, {
            byte_length: 1,
            part_digest: '00'.repeat(32),
        }));
        assert.strictEqual((await completeGroup(db, input(vector, 99))).result, 'complete');
        assert.strictEqual(completionCalls(db).length, 1);
    });
});

describe('FILE multipart completion missing part @regression @tier1', function(){
    it('does not read or write a completion', async function(){
        const vector = vectors[1];
        const db = createMemoryMultipartDb();
        await db.createManifest(manifest(vector, 10));
        await db.createPart(part(vector, vector.parts[0], 20));
        const before = db.calls.length;
        assert.strictEqual(await completeGroup(db, input(vector, 20)), null);
        assert.deepStrictEqual(db.calls.slice(before), ['getGroup']);
    });
});

describe('FILE multipart completion high position @regression @tier1', function(){
    it('ignores a position at the manifest part count', async function(){
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

describe('FILE multipart completion foreign source @regression @tier1', function(){
    it('does not assemble another source parts', async function(){
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

describe('FILE multipart completion duplicate manifest @regression @tier1', function(){
    it('binds the row to the lowest action index manifest', async function(){
        const vector = vectors[0];
        const db = await seeded(vector);
        await db.createManifest(manifest(vector, 50));
        const row = await completeGroup(db, input(vector, 50));
        assert.strictEqual(row.manifest_action_index, 10);
        assert.strictEqual(completionCalls(db).length, 1);
    });
});

describe('FILE multipart completion mismatch @regression @tier1', function(){
    it('writes mismatch when the winning digest is wrong', async function(){
        const vector = vectors[0];
        const db = await seeded(vector);
        await db.createPart(part(vector, vector.parts[0], 5, {
            part_digest: '00'.repeat(32),
        }));
        assert.strictEqual((await completeGroup(db, input(vector, 21))).result, 'mismatch');
    });
});

describe('FILE multipart completion one write @regression @tier1', function(){
    it('keeps the first terminal result', async function(){
        const vector = vectors[0];
        const db = await seeded(vector);
        assert.strictEqual((await completeGroup(db, input(vector, 21))).result, 'complete');
        assert.strictEqual(await completeGroup(db, input(vector, 22)), null);
        assert.strictEqual(completionCalls(db).length, 1);
    });
});

describe('FILE multipart completion rollback replay @regression @tier1', function(){
    it('re-completes after rollback below the last part', async function(){
        const vector = vectors[0];
        const db = await seeded(vector);
        assert.ok(await completeGroup(db, input(vector, 21)));
        await db.purgeAbove(20);
        assert.strictEqual(await completeGroup(db, input(vector, 20)), null);
        await db.createPart(part(vector, vector.parts[1], 22));
        assert.deepStrictEqual(await completeGroup(db, input(vector, 22, 501)), {
            action_index: 22,
            manifest_action_index: 10,
            result: 'complete',
            block_index: 501,
        });
        assert.strictEqual(completionCalls(db).length, 2);
    });
});

describe('FILE multipart completion valid piece hook @regression @tier1', function(){
    afterEach(function(){
        sinon.restore();
    });

    it('runs after a valid part is stored', async function(){
        const built = parserHarness();
        const pieces = buildMultipartPieces([Buffer.from('a'), Buffer.from('b')]);
        built.db.getGroup.resolves(parserGroup(pieces, 10, [11, 12]));
        const data = multipartActionData(pieces.parts[1], {
            source: SOURCE, blockIndex: 9, actionIndex: 12,
        });
        await built.handler.parse(pieces.parts[1].params, data, null);
        sinon.assert.callOrder(built.db.createPart, built.db.getGroup, built.db.createCompletion);
        sinon.assert.calledOnceWithExactly(built.db.createCompletion, {
            ACTION_INDEX: 12, MANIFEST_ACTION_INDEX: 10,
            RESULT: 'complete', BLOCK_INDEX: 9,
        });
    });

    it('runs after a valid manifest is stored', async function(){
        const built = parserHarness();
        const pieces = buildMultipartPieces([Buffer.from('a'), Buffer.from('b')]);
        built.db.getGroup.onFirstCall().resolves({ manifest: null, parts: [] });
        built.db.getGroup.onSecondCall().resolves(parserGroup(pieces, 12, [10, 11]));
        const data = multipartActionData(pieces.manifest, {
            source: SOURCE, blockIndex: 9, actionIndex: 12,
        });
        await built.handler.parse(pieces.manifest.params, data, null);
        assert.ok(built.db.createManifest.firstCall.callId < built.db.getGroup.secondCall.callId);
        assert.ok(built.db.getGroup.secondCall.callId < built.db.createCompletion.firstCall.callId);
        sinon.assert.calledOnceWithExactly(built.db.createCompletion, {
            ACTION_INDEX: 12, MANIFEST_ACTION_INDEX: 12,
            RESULT: 'complete', BLOCK_INDEX: 9,
        });
    });
});

describe('FILE multipart completion invalid piece hook @regression @tier1', function(){
    afterEach(function(){
        sinon.restore();
    });

    it('does not run after an invalid part is stored', async function(){
        const built = parserHarness();
        const pieces = buildMultipartPieces([Buffer.from('a'), Buffer.from('b')]);
        const invalid = { ...pieces.parts[0], rawData: Buffer.alloc(0) };
        const data = multipartActionData(invalid, {
            source: SOURCE, blockIndex: 9, actionIndex: 11,
        });
        await built.handler.parse(invalid.params, data, null);
        assert.strictEqual(data['STATUS'], 'invalid: RAW_DATA (empty part)');
        sinon.assert.notCalled(built.db.getGroup);
        sinon.assert.notCalled(built.db.createCompletion);
    });
});
