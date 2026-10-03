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
const prices = require('../../../src/db/prices');

describe('Database.getMaxBatchBlockTime() @regression @tier1', function () {
    it('returns the maximum batch block time as a Number', async function () {
        const db = {
            async doQueryStrict(){ return [{ max_batch_block_time: '1700000123' }]; }
        };
        assert.strictEqual(await prices.getMaxBatchBlockTime.call(db), 1700000123);
    });

    it('returns zero when no finalized landed batch qualifies', async function () {
        const db = {
            async doQueryStrict(){ return [{ max_batch_block_time: null }]; }
        };
        assert.strictEqual(await prices.getMaxBatchBlockTime.call(db), 0);
    });

    it('uses the finalized landed-batch predicate', async function () {
        let seenSql = null;
        const db = {
            async doQueryStrict(sql){
                seenSql = sql;
                return [{ max_batch_block_time: null }];
            }
        };
        await prices.getMaxBatchBlockTime.call(db);
        assert.match(seenSql, /status\s*=\s*'finalized'/i);
        assert.match(seenSql, /batch_block_time\s*>\s*0/i);
    });

    it('propagates a strict-read rejection', async function () {
        const fault = new Error('database unavailable');
        const db = {
            async doQueryStrict(){ throw fault; }
        };
        await assert.rejects(() => prices.getMaxBatchBlockTime.call(db), err => err === fault);
    });
});
