// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const assert = require('assert');
const { buildFile } = require('./contract/file.test/helpers/fixture.js');
const {
    buildMultipartPieces,
    multipartActionData,
    withMultipartFlag,
} = require('../../helpers/file_multipart_pieces.js');

const RAW_PARTS = [
    Buffer.from('6d756c746970617274', 'hex'),
    Buffer.from('2072617720766563746f72', 'hex'),
];
const RAW_DIGESTS = [
    '8172978f4154919d2c6680671d8417514522d4ae5f9171931390a69ef68ad3fc',
    '34570c20975b553f979ce41439d435b2e5c7433b705101bf4ecbfa715cfba38d',
];
const RAW_HASH = '94d17c51c075eff21c1553f699074c8a136b2e2b87d9bd9b10dfe9d4c2fa6827';
const REBALANCED_PARTS = [
    Buffer.from('31323334', 'hex'),
    Buffer.from('353637', 'hex'),
    Buffer.from('3839', 'hex'),
];
const REBALANCED_DIGESTS = [
    '03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4',
    '97a6d21df7c51e8289ac1a8c026aaac143e15aa1957f54f42e30d8f8a85c3a55',
    'cd70bea023f752a0564abb6ed08d42c1440f2e33e29914e55e0be1595e24f45a',
];

describe('multipart FILE documented vectors', function () {
    it('reproduces the two-part raw vector', function () {
        const built = buildMultipartPieces(RAW_PARTS);
        assert.strictEqual(built.fileHash, RAW_HASH);
        assert.strictEqual(built.totalParts, 2);
        assert.strictEqual(built.totalBytes, 20);
        assert.deepStrictEqual(built.parts.map(part => part.digest), RAW_DIGESTS);
    });

    it('reproduces the final-slice-rebalanced vector', function () {
        const built = buildMultipartPieces(REBALANCED_PARTS);
        assert.strictEqual(built.fileHash,
            'e1fd7542c04788dcd722a68a66c59561605456df0b447267918bb8724f6cd1cc');
        assert.strictEqual(built.totalParts, 3);
        assert.strictEqual(built.totalBytes, 9);
        assert.deepStrictEqual(built.parts.map(part => part.digest), REBALANCED_DIGESTS);
    });
});

describe('multipart FILE manifest encoding', function () {
    it('builds the exact compact command for a named raw file', function () {
        const built = buildMultipartPieces(RAW_PARTS, {
            name: 'raw.bin', type: 'application/octet-stream',
        });
        assert.strictEqual(built.manifest.command,
            `FILE|1|${RAW_HASH}|2|20|raw.bin|application/octet-stream`);
    });

    it('keeps inner empty fields in a gated manifest', function () {
        const built = buildMultipartPieces(RAW_PARTS, {
            name: 'secret.bin', type: 'application/octet-stream',
            gateTicker: 'TEST', encryptionMethod: '1', keyHash: 'a'.repeat(64),
            gateMinAmount: '2.5',
        });
        assert.deepStrictEqual(built.manifest.params.slice(4), [
            'secret.bin', 'application/octet-stream', '', '', 'TEST', '1',
            'a'.repeat(64), '2.5',
        ]);
    });
});

describe('multipart FILE forged wire values', function () {
    it('preserves every override while computing each digest from bytes', function () {
        const built = buildMultipartPieces(RAW_PARTS, {
            fileHash: 'A'.repeat(64), totalParts: '02', totalBytes: '020',
        });
        assert.deepStrictEqual(built.manifest.params.slice(1, 4), [
            'A'.repeat(64), '02', '020',
        ]);
        assert.ok(built.parts.every(part => part.params[1] === 'A'.repeat(64)));
        assert.deepStrictEqual(built.parts.map(part => part.digest), RAW_DIGESTS);
        assert.strictEqual(built.fileHash, RAW_HASH);
        assert.deepStrictEqual([built.totalParts, built.totalBytes], [2, 20]);
    });
});

describe('multipart FILE action data', function () {
    const ctx = { source: 'source', blockIndex: 4, actionIndex: 9 };

    it('omits RAW_DATA from a manifest', function () {
        const { manifest } = buildMultipartPieces(RAW_PARTS);
        const data = multipartActionData(manifest, ctx);
        assert.strictEqual(Object.hasOwn(data, 'RAW_DATA'), false);
        assert.deepStrictEqual([data.ACTION, data.FORMAT, data.TX_DATA],
            ['FILE', 1, manifest.command]);
    });

    it('keeps a zero batch position and sibling actions', function () {
        const { manifest } = buildMultipartPieces(RAW_PARTS);
        const siblings = [{ ACTION: 'MESSAGE' }];
        const data = multipartActionData(manifest, {
            ...ctx, batchPosition: 0, siblingActions: siblings,
        });
        assert.strictEqual(data.BATCH_POSITION, 0);
        assert.strictEqual(data.SIBLING_ACTIONS, siblings);
    });

    it('gives an unbatched part bytes and neither batch key', function () {
        const { parts } = buildMultipartPieces(RAW_PARTS);
        const data = multipartActionData(parts[0], ctx);
        assert.strictEqual(data.RAW_DATA, RAW_PARTS[0]);
        assert.strictEqual(Object.hasOwn(data, 'BATCH_POSITION'), false);
        assert.strictEqual(Object.hasOwn(data, 'SIBLING_ACTIONS'), false);
    });
});

describe('multipart FILE protocol flag stub', function () {
    it('resolves the multipart flag false and every other flag true', async function () {
        const { actionsCtx } = buildFile();
        const stub = withMultipartFlag(actionsCtx, false);
        assert.strictEqual(await stub('FILE_MULTIPART', 10), false);
        assert.strictEqual(await stub('OTHER_FLAG', 10), true);
    });

    it('resolves the multipart flag true and every other flag true', async function () {
        const { actionsCtx } = buildFile();
        const stub = withMultipartFlag(actionsCtx, true);
        assert.strictEqual(await stub('FILE_MULTIPART', 10), true);
        assert.strictEqual(await stub('OTHER_FLAG', 10), true);
    });
});
