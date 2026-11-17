// Copyright (c) 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

'use strict';

const crypto = require('crypto');
const { completeGroup } = require('../../src/actions/file_multipart.js');
const { createMemoryMultipartDb } = require('./multipart_memory_db.js');

function numericSeed(seed){
    if(Number.isSafeInteger(seed)) return seed >>> 0;

    let value = 2166136261;
    for(const byte of Buffer.from(String(seed))){
        value ^= byte;
        value = Math.imul(value, 16777619);
    }
    return value >>> 0;
}

function generator(seed){
    let state = numericSeed(seed) || 0x6d2b79f5;
    return function random(){
        state += 0x6d2b79f5;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 0x100000000;
    };
}

function randomInteger(random, upperBound){
    return Math.floor(random() * upperBound);
}

function randomBytes(random, length){
    return Buffer.from(Array.from({ length }, () => randomInteger(random, 256)));
}

function digest(bytes){
    return crypto.createHash('sha256').update(bytes).digest();
}

function shuffle(items, random){
    for(let index = items.length - 1; index > 0; index -= 1){
        const other = randomInteger(random, index + 1);
        [items[index], items[other]] = [items[other], items[index]];
    }
    return items;
}

function cutActionIndex(cut){
    const value = typeof cut === 'object' && cut !== null
        ? cut.action_index ?? cut.actionIndex
        : cut;
    if(!Number.isSafeInteger(value) || value < 0)
        throw new TypeError('cut points must be non-negative safe integers');
    return value;
}

function completingActionIndex(rows, totalParts){
    let hasManifest = false;
    const positions = new Set();
    for(const item of rows){
        if(item.row.status !== 'valid') continue;
        if(item.type === 'manifest') hasManifest = true;
        else if(item.row.part_index >= 0 && item.row.part_index < totalParts)
            positions.add(item.row.part_index);
        if(hasManifest && positions.size === totalParts) return item.row.action_index;
    }
    return null;
}

function pieceSequence(seed, opts={}){
    const random = generator(seed);
    const totalParts = opts.totalParts === undefined
        ? 2 + randomInteger(random, 7)
        : opts.totalParts;
    if(!Number.isSafeInteger(totalParts) || totalParts < 2)
        throw new TypeError('totalParts must be a safe integer of at least 2');

    const source = opts.source || 'source-' + numericSeed(seed).toString(16);
    const partBytes = Array.from({ length: totalParts }, () =>
        randomBytes(random, 1 + randomInteger(random, 32)));
    const partDigests = partBytes.map(digest);
    const fileHash = crypto.createHash('sha256')
        .update(Buffer.concat(partDigests)).digest('hex');
    const totalBytes = partBytes.reduce((sum, bytes) => sum + bytes.length, 0);
    const duplicatePosition = randomInteger(random, totalParts);
    const secondDuplicatePosition = (duplicatePosition + 1) % totalParts;
    const lowOutOfRangeBytes = randomBytes(random, 1 + randomInteger(random, 32));
    const highOutOfRangeBytes = randomBytes(random, 1 + randomInteger(random, 32));
    const invalidManifest = {
        type: 'manifest',
        row: {
            source,
            file_hash: fileHash,
            total_parts: totalParts,
            total_bytes: totalBytes,
            status: 'invalid: FILE_HASH (duplicate manifest)',
        },
    };
    const validManifest = {
        type: 'manifest',
        row: {
            source,
            file_hash: fileHash,
            total_parts: totalParts,
            total_bytes: totalBytes,
            status: 'valid',
        },
    };
    const parts = partBytes.map((bytes, partIndex) => ({
        type: 'part',
        bytes,
        row: {
            source,
            file_hash: fileHash,
            part_index: partIndex,
            byte_length: bytes.length,
            part_digest: partDigests[partIndex].toString('hex'),
            status: 'valid',
        },
    }));
    const duplicate = {
        type: 'part',
        bytes: Buffer.from(partBytes[duplicatePosition]),
        row: { ...parts[duplicatePosition].row },
    };
    const secondDuplicate = {
        type: 'part',
        bytes: Buffer.from(partBytes[secondDuplicatePosition]),
        row: { ...parts[secondDuplicatePosition].row },
    };
    const lowOutOfRange = {
        type: 'part',
        bytes: lowOutOfRangeBytes,
        row: {
            source,
            file_hash: fileHash,
            part_index: -1,
            byte_length: lowOutOfRangeBytes.length,
            part_digest: digest(lowOutOfRangeBytes).toString('hex'),
            status: 'valid',
        },
    };
    const highOutOfRange = {
        type: 'part',
        bytes: highOutOfRangeBytes,
        row: {
            source,
            file_hash: fileHash,
            part_index: totalParts + randomInteger(random, 3),
            byte_length: highOutOfRangeBytes.length,
            part_digest: digest(highOutOfRangeBytes).toString('hex'),
            status: 'valid',
        },
    };

    const pieces = shuffle([
        invalidManifest,
        validManifest,
        ...parts,
        duplicate,
        secondDuplicate,
        lowOutOfRange,
        highOutOfRange,
    ], random);
    const invalidIndex = pieces.indexOf(invalidManifest);
    const validIndex = pieces.indexOf(validManifest);
    if(invalidIndex > validIndex)
        [pieces[invalidIndex], pieces[validIndex]] = [pieces[validIndex], pieces[invalidIndex]];

    for(const [offset, piece] of pieces.entries()){
        piece.row.action_index = 10 + offset;
    }

    const requestedWithhold = opts.withholdPart ?? opts.withheldPart ?? false;
    const withheldPart = requestedWithhold === true
        ? numericSeed(String(seed) + ':withheld') % totalParts
        : requestedWithhold;
    if(withheldPart !== false && withheldPart !== null && withheldPart !== undefined){
        if(!Number.isSafeInteger(withheldPart) || withheldPart < 0 || withheldPart >= totalParts)
            throw new RangeError('withheld part must be a position in the sequence');
        for(let index = pieces.length - 1; index >= 0; index -= 1){
            const piece = pieces[index];
            if(piece.type === 'part' && piece.row.part_index === withheldPart)
                pieces.splice(index, 1);
        }
    }

    const completionAt = completingActionIndex(pieces, totalParts);
    const maxActionIndex = Math.max(...pieces.map(piece => piece.row.action_index));
    let requestedCuts = opts.cutPoints ?? opts.cuts;
    if(requestedCuts === undefined){
        const defaultCut = opts.cutBelowCompletion && completionAt !== null
            ? completionAt - 1
            : maxActionIndex;
        requestedCuts = [Number.isSafeInteger(opts.cutAt) ? opts.cutAt : defaultCut];
    }
    if(!Array.isArray(requestedCuts)) throw new TypeError('cutPoints must be an array');
    const cuts = requestedCuts.map(cut => ({
        type: 'cut',
        action_index: cutActionIndex(cut),
    }));

    return {
        seed,
        source,
        fileHash,
        totalParts,
        totalBytes,
        partBytes,
        withheldPart: withheldPart === false ? null : withheldPart,
        completingActionIndex: completionAt,
        rows: pieces,
        pieces,
        cuts,
        events: [...pieces, ...cuts],
    };
}

async function baselineCompletions(sequence){
    const db = createMemoryMultipartDb();
    const manifestActionIndexes = new Set();

    for(const piece of sequence.events || sequence.pieces){
        if(piece.type === 'cut'){
            await db.purgeAbove(piece.action_index);
            continue;
        }
        if(piece.type === 'manifest') await db.createManifest(piece.row);
        else if(piece.type === 'part') await db.createPart(piece.row);
        else throw new TypeError('unknown multipart piece type');

        if(piece.row.status !== 'valid') continue;
        const completion = await completeGroup(db, {
            source: piece.row.source,
            fileHash: piece.row.file_hash,
            actionIndex: piece.row.action_index,
            blockIndex: 1000 + piece.row.action_index,
        });
        if(completion) manifestActionIndexes.add(completion.manifest_action_index);
    }

    const completions = await Promise.all(Array.from(manifestActionIndexes,
        manifestActionIndex => db.getCompletion(manifestActionIndex)));
    return completions.filter(row => row !== null);
}

module.exports = { baselineCompletions, pieceSequence };
