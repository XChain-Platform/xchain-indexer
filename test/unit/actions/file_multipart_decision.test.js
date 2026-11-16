// Copyright © 2025-2026 Dankest, LLC
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
const { decideCompletionWrite } = require('../../../src/actions/file_multipart_decision.js');

function multipartGroup() {
    return {
        manifest: {
            action_index: 10,
            file_hash: 'a'.repeat(64),
            total_parts: 2,
            total_bytes: 7,
        },
        parts: [
            { part_index: 0, action_index: 11, byte_length: 3, part_digest: 'b'.repeat(64) },
            { part_index: 1, action_index: 12, byte_length: 4, part_digest: 'c'.repeat(64) },
        ],
    };
}

function decide(overrides = {}) {
    return decideCompletionWrite(Object.assign({
        group: multipartGroup(),
        verdict: 'complete',
        existingCompletion: null,
        pieceActionIndex: 12,
        blockIndex: 100,
    }, overrides));
}

describe('FILE multipart completion write decision', function () {
    it('returns the completion row for a complete assembly', function () {
        assert.deepStrictEqual(decide(), {
            action_index: 12,
            manifest_action_index: 10,
            result: 'complete',
            block_index: 100,
        });
    });

    it('returns the completion row for a mismatched assembly', function () {
        assert.deepStrictEqual(decide({ verdict: 'mismatch', pieceActionIndex: 15, blockIndex: 101 }), {
            action_index: 15,
            manifest_action_index: 10,
            result: 'mismatch',
            block_index: 101,
        });
    });

    it('returns null for a null verdict', function () {
        assert.strictEqual(decide({ verdict: null }), null);
    });

    it('returns null for a non-terminal verdict', function () {
        assert.strictEqual(decide({ verdict: 'pending' }), null);
    });

    it('returns null when the existing completion is complete', function () {
        assert.strictEqual(decide({
            existingCompletion: { action_index: 12, result: 'complete' },
        }), null);
    });

    it('returns null when the existing completion is a mismatch', function () {
        assert.strictEqual(decide({
            existingCompletion: { action_index: 12, result: 'mismatch' },
        }), null);
    });

    it('accepts an action index equal to the greatest piece action index', function () {
        assert.deepStrictEqual(decide({ pieceActionIndex: 12 }), {
            action_index: 12,
            manifest_action_index: 10,
            result: 'complete',
            block_index: 100,
        });
    });

    it('rejects an action index below the manifest action index', function () {
        assert.throws(() => decide({ pieceActionIndex: 9 }), RangeError);
    });

    it('rejects an action index below any part action index', function () {
        assert.throws(() => decide({ pieceActionIndex: 11 }), RangeError);
    });

    it('rejects a non-null verdict when the group has no manifest', function () {
        const group = multipartGroup();
        group.manifest = null;
        assert.throws(() => decide({ group }), TypeError);
    });

    it('does not mutate any input object', function () {
        const input = {
            group: multipartGroup(),
            verdict: 'mismatch',
            existingCompletion: null,
            pieceActionIndex: 12,
            blockIndex: 100,
        };
        const before = structuredClone(input);

        decideCompletionWrite(input);

        assert.deepStrictEqual(input, before);
    });
});
