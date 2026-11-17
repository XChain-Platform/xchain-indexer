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
const crypto = require('crypto');
const File = require('../../../src/actions/file.js');
const { completeGroup } = require('../../../src/actions/file_multipart.js');
const rederive = require('../../../src/db/rollback/rederive.js');
const { createMemoryMultipartDb } = require('../../helpers/multipart_memory_db.js');

function randomFor(seed){
    let state = crypto.createHash('sha256').update(String(seed)).digest().readUInt32LE(0);
    return function random(){
        state += 0x6d2b79f5;
        let value = state;
        value = Math.imul(value ^ value >>> 15, value | 1);
        value ^= value + Math.imul(value ^ value >>> 7, value | 61);
        return ((value ^ value >>> 14) >>> 0) / 0x100000000;
    };
}

function shuffled(items, random){
    const result = items.slice();
    for(let index = result.length - 1; index > 0; index -= 1){
        const swap = Math.floor(random() * (index + 1));
        [result[index], result[swap]] = [result[swap], result[index]];
    }
    return result;
}

function identity(parts){
    const digests = parts.map(bytes => crypto.createHash('sha256').update(bytes).digest());
    return {
        digests,
        fileHash: crypto.createHash('sha256').update(Buffer.concat(digests)).digest('hex'),
        totalBytes: parts.reduce((sum, bytes) => sum + bytes.length, 0),
    };
}

function templates(seed, random){
    const totalParts = 3 + Math.floor(random() * 6);
    const parts = Array.from({ length: totalParts }, (_, position) =>
        Buffer.alloc(1 + Math.floor(random() * 24), position + seed));
    const file = identity(parts);
    const common = { source: `source-${seed}`, file_hash: file.fileHash, status: 'valid' };
    const manifest = {
        ...common, total_parts: totalParts, total_bytes: file.totalBytes,
    };
    const partRows = parts.map((bytes, position) => ({
        ...common, part_index: position, byte_length: bytes.length,
        part_digest: file.digests[position].toString('hex'),
    }));
    return { manifest, partRows, totalParts };
}

function sequenceFor(seed){
    const random = randomFor(seed);
    const made = templates(seed, random);
    const withheld = seed % 5 === 0 ? Math.floor(random() * made.totalParts) : null;
    const parts = made.partRows.filter(row => row.part_index !== withheld);
    const duplicate = { ...parts[Math.floor(random() * parts.length)] };
    const high = { ...made.partRows[0], part_index: made.totalParts + 2 };
    const validManifest = { type: 'manifest', row: made.manifest };
    const rows = shuffled([
        validManifest, ...parts.map(row => ({ type: 'part', row })),
        { type: 'part', row: duplicate }, { type: 'part', row: high },
    ], random);
    const validAt = rows.indexOf(validManifest);
    rows.splice(Math.floor(random() * (validAt + 1)), 0, {
        type: 'manifest', row: { ...made.manifest, status: 'invalid: TOTAL_PARTS (range)' },
    });
    const assigned = rows.map((item, offset) => ({
        ...item, row: { ...item.row, action_index: 100 + offset },
    }));
    const cut = seed % 7 === 0 ? 100 + Math.floor(assigned.length / 2) : assigned.at(-1).row.action_index;
    return { events: [...assigned, { type: 'cut', action_index: cut }] };
}

function pieceInput(row){
    return {
        source: row.source, fileHash: row.file_hash,
        actionIndex: row.action_index, blockIndex: 1000 + row.action_index,
    };
}

async function purgeAt(db, lastActionIndex){
    let deletes = 0;
    const sqlDb = {
        async doQuery(query, args){
            assert.match(query, /^DELETE FROM file_(manifests|parts|completions)/);
            assert.deepStrictEqual(args, [lastActionIndex + 1]);
            deletes += 1;
            if(deletes === 3) await db.purgeAbove(lastActionIndex);
            return [];
        },
    };
    await rederive.purgeActionScopedTables(sqlDb,
        ['file_manifests', 'file_parts', 'file_completions'], lastActionIndex + 1);
}

async function baselineCompletions(sequence){
    const db = createMemoryMultipartDb();
    for(const event of sequence.events){
        if(event.type === 'cut'){
            await purgeAt(db, event.action_index);
            continue;
        }
        if(event.type === 'manifest') await db.createManifest(event.row);
        else await db.createPart(event.row);
        if(event.row.status === 'valid') await completeGroup(db, pieceInput(event.row));
    }
    return db.completionRows;
}

async function storeIncremental(handler, db, event){
    const row = event.row;
    if(event.type === 'manifest'){
        const filled = row.status === 'valid'
            ? await handler.countFilledAtManifest({
                SOURCE: row.source, FILE_HASH: row.file_hash, TOTAL_PARTS: row.total_parts,
            })
            : null;
        await db.createManifest({ ...row, filled_at_manifest: filled });
        if(filled === row.total_parts) await completeGroup(db, pieceInput(row));
        return;
    }
    const fill = row.status === 'valid'
        ? await handler.nextPartFill({
            SOURCE: row.source, FILE_HASH: row.file_hash, PART_INDEX: row.part_index,
        })
        : { ordinal: null, completes: false };
    await db.createPart({ ...row, fill_ordinal: fill.ordinal });
    if(fill.completes) await completeGroup(db, pieceInput(row));
}

async function incrementalRun(sequence){
    const db = createMemoryMultipartDb();
    const handler = Object.create(File.prototype);
    handler.indexerDb = db;
    for(const event of sequence.events){
        if(event.type === 'cut') await purgeAt(db, event.action_index);
        else await storeIncremental(handler, db, event);
    }
    return db;
}

describe('FILE multipart incremental completion equivalence @regression @tier1', function(){
    it('matches the per-piece full verdict across 500 seeded sequences', async function(){
        for(let seed = 0; seed < 500; seed += 1){
            const sequence = sequenceFor(seed);
            const expected = await baselineCompletions(sequence);
            const actual = (await incrementalRun(sequence)).completionRows;
            assert.deepStrictEqual(actual, expected, `seed ${seed}`);
        }
    });
});

describe('FILE multipart incremental read bound @regression @tier1', function(){
    for(const totalParts of [4, 4096]){
        it(`uses three counter reads for a part in a ${totalParts}-part file`, async function(){
            const db = createMemoryMultipartDb();
            await db.createManifest({
                action_index: 1, source: 'source', file_hash: 'a'.repeat(64),
                total_parts: totalParts, total_bytes: totalParts, status: 'valid',
                filled_at_manifest: 0,
            });
            const handler = Object.create(File.prototype);
            handler.indexerDb = db;
            db.resetReadCount();
            const fill = await handler.nextPartFill({
                SOURCE: 'source', FILE_HASH: 'a'.repeat(64), PART_INDEX: 0,
            });
            assert.strictEqual(fill.ordinal, 1);
            assert.strictEqual(db.readCount, 3);
        });
    }

    it('runs the full group read once when one file fills', async function(){
        const sequence = sequenceFor(41);
        const db = await incrementalRun(sequence);
        assert.strictEqual(db.completionRows.length, 1);
        assert.strictEqual(db.calls.filter(call => call === 'getGroup').length, 1);
    });
});
