/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 *********************************************************************/

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const prices = require('../../../src/db/prices');

function walkJavaScript(dir){
    const files = [];
    for(const entry of fs.readdirSync(dir, { withFileTypes: true })){
        const absolute = path.join(dir, entry.name);
        if(entry.isDirectory()) files.push(...walkJavaScript(absolute));
        else if(entry.name.endsWith('.js')) files.push(absolute);
    }
    return files;
}

describe('Database.getMaxBatchBlockTime() @regression @tier1', function () {
    it('returns the maximum batch block time as a Number', async function () {
        const calls = [];
        const db = {
            assertPriceBarrierNotSkipped(name){ calls.push(['assert', name]); },
            async doQueryStrict(){ calls.push(['query']); return [{ max_batch_block_time: '1700000123' }]; }
        };
        assert.strictEqual(await prices.getMaxBatchBlockTime.call(db), 1700000123);
        assert.deepStrictEqual(calls, [['assert', 'getMaxBatchBlockTime'], ['query']]);
    });

    it('returns zero when no finalized landed batch qualifies', async function () {
        const db = {
            assertPriceBarrierNotSkipped(){},
            async doQueryStrict(){ return [{ max_batch_block_time: null }]; }
        };
        assert.strictEqual(await prices.getMaxBatchBlockTime.call(db), 0);
    });

    it('uses the finalized landed-batch predicate', async function () {
        let seenSql = null;
        const db = {
            assertPriceBarrierNotSkipped(){},
            async doQueryStrict(sql){
                seenSql = sql;
                return [{ max_batch_block_time: null }];
            }
        };
        await prices.getMaxBatchBlockTime.call(db);
        assert.match(seenSql, /status\s*=\s*'finalized'/i);
        assert.match(seenSql, /batch_block_time\s*>\s*0/i);
        const repo = path.resolve(__dirname, '../../..');
        const callers = walkJavaScript(path.join(repo, 'src'))
            .filter(file => /getMaxBatchBlockTime/.test(fs.readFileSync(file, 'utf8')))
            .map(file => path.relative(repo, file).split(path.sep).join('/'))
            .sort();
        assert.deepStrictEqual(callers, ['src/db/prices/index.js'],
            'the uncapped tooling read must not gain a consensus source caller');
    });

    it('propagates a strict-read rejection', async function () {
        const fault = new Error('database unavailable');
        const db = {
            assertPriceBarrierNotSkipped(){},
            async doQueryStrict(){ throw fault; }
        };
        await assert.rejects(() => prices.getMaxBatchBlockTime.call(db), err => err === fault);
    });
});
