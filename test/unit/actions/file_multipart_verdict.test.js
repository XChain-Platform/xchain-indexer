// Copyright (c) 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const assert = require('assert');
const vectors = require('../../fixtures/multipart_file.json').vectors;
const { assemblyVerdict } = require('../../../src/actions/file_multipart.js');

function groupFor(vector){
    return {
        manifest: {
            action_index: 10,
            file_hash: vector.FILE_HASH,
            total_parts: vector.TOTAL_PARTS,
            total_bytes: vector.TOTAL_BYTES,
        },
        parts: vector.parts.map((part, offset) => ({
            part_index: part.PART_INDEX,
            action_index: 20 + offset,
            byte_length: Buffer.from(part.hex, 'hex').length,
            part_digest: part.digest,
        })).reverse(),
    };
}

describe('FILE multipart assembly verdict @regression @tier1', function(){
    for(const vector of vectors){
        it('matches the documentation vector: ' + vector.name, function(){
            assert.strictEqual(assemblyVerdict(groupFor(vector)), vector.expected);
        });
    }

    it('keeps the lowest action index for a duplicate position', function(){
        const group = groupFor(vectors[0]);
        const duplicate = {
            part_index: 0,
            action_index: 99,
            byte_length: 1,
            part_digest: '00'.repeat(32),
        };
        group.parts.push(duplicate);
        assert.strictEqual(assemblyVerdict(group), 'complete');

        duplicate.action_index = 1;
        assert.strictEqual(assemblyVerdict(group), 'mismatch');
    });

    it('returns null while an in-range position is missing', function(){
        const group = groupFor(vectors[1]);
        group.parts = group.parts.filter((part) => part.part_index !== 1);
        assert.strictEqual(assemblyVerdict(group), null);
    });

    it('ignores positions at or above total_parts', function(){
        const group = groupFor(vectors[0]);
        group.parts.push({
            part_index: group.manifest.total_parts,
            action_index: 1,
            byte_length: 500,
            part_digest: '00'.repeat(32),
        });
        assert.strictEqual(assemblyVerdict(group), 'complete');
    });

    it('returns null when the manifest is absent', function(){
        assert.strictEqual(assemblyVerdict({ manifest: null, parts: groupFor(vectors[0]).parts }), null);
    });

    it('returns mismatch when the byte lengths do not sum to total_bytes', function(){
        const group = groupFor(vectors[0]);
        group.manifest.total_bytes += 1;
        assert.strictEqual(assemblyVerdict(group), 'mismatch');
    });
});
