/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 **********************************************************************
 * Unit: refused DEPLOY carrier text storage
 */

'use strict';

const assert = require('assert');

const deploys = require('../../../../src/db/deploys/index.js');

async function storedValues(overrides){
    const writes = [];
    const self = {
        normalizeDataValues: value => value,
        createStatus: async () => 7,
        getAddressId: async () => 8,
        doQuery: async (sql, params) => {
            if(/^SELECT/.test(sql)) return [];
            writes.push(params);
            return [];
        }
    };
    const data = Object.assign({
        STATUS: 'invalid: test', SOURCE: 'source', ACTION_INDEX: 9,
        CODE_HASH: 'a'.repeat(64), CHUNK_INDEX: 0, TOTAL_CHUNKS: 1,
        CODE_PART: 'aGVsbG8=', BLOCK_INDEX: 10
    }, overrides);
    await deploys.recordDeployChunk.call(self, data);
    return writes[0];
}

describe('refused DEPLOY carrier text storage @regression @tier1', function(){
    it('clips an over-width hash to the CHAR(64) column', async function(){
        const values = await storedValues({ CODE_HASH: 'a'.repeat(65) });
        assert.strictEqual(values[1], 'a'.repeat(64));
    });

    it('maps a four-byte hash character for the utf8mb3 column', async function(){
        const values = await storedValues({ CODE_HASH: '\u{1F600}' + 'a'.repeat(63) });
        assert.strictEqual(values[1], '\uFFFD' + 'a'.repeat(63));
    });

    it('stores placeholders for missing required text fields', async function(){
        const values = await storedValues({ CODE_HASH: undefined, CODE_PART: undefined });
        assert.strictEqual(values[1], '');
        assert.strictEqual(values[4], '');
    });

    it('keeps refused text that already fits byte-identical', async function(){
        const values = await storedValues({ CODE_HASH: 'ABC', CODE_PART: 'part' });
        assert.strictEqual(values[1], 'ABC');
        assert.strictEqual(values[4], 'part');
    });

    it('keeps valid carrier text byte-identical', async function(){
        const hash = 'b'.repeat(64);
        const values = await storedValues({ STATUS: 'valid', CODE_HASH: hash, CODE_PART: 'part' });
        assert.strictEqual(values[1], hash);
        assert.strictEqual(values[4], 'part');
    });
});
