// Copyright (c) 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const {
    baselineCompletions,
    pieceSequence,
} = require('../../helpers/multipart_piece_sequences.js');

describe('multipart piece sequence oracle @regression @tier1', function(){
    it('repeats a seed with shuffled duplicates and edge rows', function(){
        const first = pieceSequence(31991);
        const second = pieceSequence(31991);
        assert.deepStrictEqual(first, second);

        const manifests = first.pieces.filter(piece => piece.type === 'manifest');
        assert.ok(first.pieces.indexOf(manifests[0]) < first.pieces.indexOf(manifests[1]));
        assert.notStrictEqual(manifests[0].row.status, 'valid');
        assert.strictEqual(manifests[1].row.status, 'valid');

        const parts = first.pieces.filter(piece => piece.type === 'part');
        const positions = parts.map(piece => piece.row.part_index);
        assert.ok(positions.some((position, index) => positions.indexOf(position) !== index));
        assert.ok(positions.some(position => position < 0));
        assert.ok(positions.some(position => position >= first.totalParts));
        for(const piece of parts){
            const actual = crypto.createHash('sha256').update(piece.bytes).digest('hex');
            assert.strictEqual(piece.row.part_digest, actual);
            assert.strictEqual(piece.row.byte_length, piece.bytes.length);
        }
        assert.ok(first.pieces.some((piece, index) => piece.row.action_index !== index));
        assert.deepStrictEqual(first.events, [...first.rows, ...first.cuts]);
        assert.strictEqual(first.cuts.length, 1);
    });

    it('generates 500 seeded sequences', function(){
        for(let seed = 0; seed < 500; seed += 1){
            const sequence = pieceSequence(seed);
            assert.ok(sequence.pieces.length >= sequence.totalParts + 4);
            assert.ok(sequence.totalBytes >= sequence.totalParts);
        }
    });

    it('completes a full sequence once', async function(){
        const completions = await baselineCompletions(pieceSequence('full-sequence'));
        assert.strictEqual(completions.length, 1);
        assert.strictEqual(completions[0].result, 'complete');
    });

    it('does not complete when one position is withheld', async function(){
        const sequence = pieceSequence('withheld-sequence', { withholdPart: true });
        assert.ok(Number.isInteger(sequence.withheldPart));
        assert.ok(!sequence.pieces.some(piece =>
            piece.type === 'part' && piece.row.part_index === sequence.withheldPart));
        assert.deepStrictEqual(await baselineCompletions(sequence), []);
    });

    it('removes a completion at a cut below its piece', async function(){
        const cut = pieceSequence('cut-sequence', { cutBelowCompletion: true });
        assert.ok(cut.cuts[0].action_index < cut.completingActionIndex);
        assert.strictEqual((await baselineCompletions({
            ...cut,
            events: cut.pieces,
        })).length, 1);
        assert.deepStrictEqual(await baselineCompletions(cut), []);
    });
});
