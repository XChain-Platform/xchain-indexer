/*********************************************************************
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 ********************************************************************/

'use strict';

const assert = require('assert');
const { chainBlockHash } = require('../../../src/api/chain_block_hash');

function recordingDb(rows) {
    const calls = [];
    return {
        calls,
        async getDecoderBlockHashRow(target) {
            calls.push(target);
            return rows;
        }
    };
}

describe('chainBlockHash()', function () {
    it('stringifies a Buffer-like hash and passes the target through unchanged', async function () {
        const target = { block_index: 321 };
        const blockHash = { toString: () => 'abc123' };
        const db = recordingDb([{ block_hash: blockHash }]);

        assert.strictEqual(await chainBlockHash(db, target), 'abc123');
        assert.strictEqual(db.calls.length, 1);
        assert.strictEqual(db.calls[0], target);
    });

    it('returns null for an empty row list', async function () {
        assert.strictEqual(await chainBlockHash(recordingDb([]), 321), null);
    });

    it('returns null for null and empty block hashes', async function () {
        for (const blockHash of [null, '']) {
            const db = recordingDb([{ block_hash: blockHash }]);
            assert.strictEqual(await chainBlockHash(db, 321), null);
        }
    });
});
