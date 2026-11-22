/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 **********************************************************************
 * test/unit/actions/file_multipart_column_stub.test.js
 */

'use strict';

const assert = require('assert');
const {
    assertManifestRow,
    assertPartRow,
    makeColumnRejectingDb,
} = require('../../helpers/file_multipart_column_stub');

const HASH = 'a'.repeat(64);
const DIGEST = 'b'.repeat(64);
const UINT32_MAX = 4294967295;
const INVALID_UINT32 = [undefined, null, -1, 1.5, '1', 4294967296];

function manifest(overrides = {}){
    return { file_hash: HASH, total_parts: 1, total_bytes: 2, ...overrides };
}

function part(overrides = {}){
    return { file_hash: HASH, part_index: 0, byte_length: 2, part_digest: DIGEST, ...overrides };
}

function completion(overrides = {}){
    return { manifest_action_index: 0, result: 'complete', action_index: 1, ...overrides };
}

function rejectsColumn(assertRow, makeRow, column, values){
    for(const value of values)
        assert.throws(() => assertRow(makeRow({ [column]: value })), new RegExp(column));
}

describe('file multipart column stub', function(){
    describe('assertManifestRow', function(){
        it('returns rows at the accepted file_hash edges', function(){
            for(const file_hash of ['', HASH]){
                const row = manifest({ file_hash });
                assert.strictEqual(assertManifestRow(row), row);
            }
        });

        it('rejects non-string and 65-character file_hash values', function(){
            rejectsColumn(assertManifestRow, manifest, 'file_hash', [1, 'a'.repeat(65)]);
        });

        it('accepts both INT UNSIGNED edges for total_parts', function(){
            for(const value of [0, UINT32_MAX]){
                const row = manifest({ total_parts: value });
                assert.strictEqual(assertManifestRow(row), row);
            }
        });

        it('rejects invalid INT UNSIGNED values for total_parts', function(){
            rejectsColumn(assertManifestRow, manifest, 'total_parts', INVALID_UINT32);
        });

        it('accepts safe BIGINT UNSIGNED values for total_bytes', function(){
            for(const value of [0, 4294967296, Number.MAX_SAFE_INTEGER]){
                const row = manifest({ total_bytes: value });
                assert.strictEqual(assertManifestRow(row), row);
            }
        });

        it('rejects unsafe BIGINT UNSIGNED values for total_bytes', function(){
            rejectsColumn(assertManifestRow, manifest, 'total_bytes', [
                undefined, null, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1,
            ]);
        });
    });

    describe('assertPartRow', function(){
        it('returns rows at the accepted file_hash edges', function(){
            for(const file_hash of ['', HASH]){
                const row = part({ file_hash });
                assert.strictEqual(assertPartRow(row), row);
            }
        });

        it('rejects non-string and 65-character file_hash values', function(){
            rejectsColumn(assertPartRow, part, 'file_hash', [1, 'a'.repeat(65)]);
        });

        it('accepts an exactly 64-character part_digest', function(){
            const row = part();
            assert.strictEqual(assertPartRow(row), row);
        });

        it('rejects every part_digest that is not exactly 64 characters', function(){
            rejectsColumn(assertPartRow, part, 'part_digest', [1, '', 'b'.repeat(63), 'b'.repeat(65)]);
        });

        for(const column of ['part_index', 'byte_length']){
            it('accepts both INT UNSIGNED edges for ' + column, function(){
                for(const value of [0, UINT32_MAX]){
                    const row = part({ [column]: value });
                    assert.strictEqual(assertPartRow(row), row);
                }
            });

            it('rejects invalid INT UNSIGNED values for ' + column, function(){
                rejectsColumn(assertPartRow, part, column, INVALID_UINT32);
            });
        }
    });

    describe('makeColumnRejectingDb', function(){
        it('writes valid manifest, part, and completion rows', async function(){
            const db = makeColumnRejectingDb();
            const rows = [manifest(), part(), completion()];
            await db.createManifest(rows[0]);
            await db.createPart(rows[1]);
            await db.createCompletion(rows[2]);
            assert.deepStrictEqual(db.manifests, [rows[0]]);
            assert.deepStrictEqual(db.parts, [rows[1]]);
            assert.deepStrictEqual(db.completions, [rows[2]]);
        });

        for(const column of ['manifest_action_index', 'action_index']){
            it('accepts both INT UNSIGNED edges for completion ' + column, async function(){
                const db = makeColumnRejectingDb();
                for(const value of [0, UINT32_MAX])
                    await db.createCompletion(completion({ [column]: value }));
                assert.deepStrictEqual(db.completions.map(row => row[column]), [0, UINT32_MAX]);
            });

            it('rejects invalid INT UNSIGNED values for completion ' + column, async function(){
                for(const value of INVALID_UINT32){
                    const db = makeColumnRejectingDb();
                    await assert.rejects(db.createCompletion(completion({ [column]: value })), new RegExp(column));
                    assert.deepStrictEqual(db.completions, []);
                }
            });
        }

        it('accepts both completion result values and rejects every other value', async function(){
            const db = makeColumnRejectingDb();
            await db.createCompletion(completion({ result: 'complete' }));
            await db.createCompletion(completion({ result: 'mismatch' }));
            assert.deepStrictEqual(db.completions.map(row => row.result), ['complete', 'mismatch']);
            for(const result of [undefined, null, '', 'other', 1])
                await assert.rejects(db.createCompletion(completion({ result })), /result/);
            assert.strictEqual(db.completions.length, 2);
        });

        it('leaves every target array untouched after a rejected write', async function(){
            const db = makeColumnRejectingDb();
            await assert.rejects(db.createManifest(manifest({ total_parts: -1 })), /total_parts/);
            await assert.rejects(db.createPart(part({ part_digest: '' })), /part_digest/);
            await assert.rejects(db.createCompletion(completion({ action_index: 4294967296 })), /action_index/);
            assert.deepStrictEqual(db.manifests, []);
            assert.deepStrictEqual(db.parts, []);
            assert.deepStrictEqual(db.completions, []);
        });
    });
});
