'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');

const tickerQueries = require('../../../src/db/index_tables/tickers.js');

// One index_tickers table with binary tick equality, seeded with doge:pepe at id 40.
function harness(overrides = {}){
    const rows = [{ id: 40, tick: 'doge:pepe', block_index: 900 }];
    const inserts = [];
    const internCache = { tick: new Map() };
    const db = {
        util: { isNull: value => value === null || value === undefined || value === '' },
        transactionConnection: { id: 1 },
        blockIndex: 901,
        suppressIndexIdCreation: false,
        deterministicIndexingStarted: true,
        _internCache: internCache,
        ignoreInserts: false,

        async doQuery(sql, args = []){
            if(/SELECT id FROM index_tickers WHERE tick=\? LIMIT 1/.test(sql)){
                const row = rows.find(item => item.tick === args[0]);
                return row ? [{ id: row.id }] : [];
            }
            if(/SELECT id FROM index_tickers ORDER BY id DESC LIMIT 1 FOR UPDATE/.test(sql)){
                const max = rows.reduce((m, row) => Math.max(m, row.id), 0);
                return max === 0 ? [] : [{ id: max }];
            }
            if(/INSERT IGNORE INTO index_tickers \(`id`, `tick`, `block_index`\)/.test(sql)){
                const [id, tick, block_index] = args;
                inserts.push({ id, tick, block_index });
                if(this.ignoreInserts)
                    return { affectedRows: 0 };
                rows.push({ id, tick, block_index });
                return { affectedRows: 1 };
            }
            if(/SELECT id FROM index_tickers WHERE id=\? AND block_index IS NOT NULL LIMIT 1/.test(sql)){
                const row = rows.find(item => String(item.id) === String(args[0]));
                return row ? [{ id: row.id }] : [];
            }
            throw new Error('Unexpected query: ' + sql);
        },
        ...overrides,
    };
    Object.assign(db, tickerQueries);
    return { db, rows, inserts, internCache };
}

describe('Database createTickerExact @unit @regression', function () {
    it('assigns the next dense id to a case variant and stamps the block', async function () {
        const { db, rows, inserts, internCache } = harness();
        const id = await db.createTickerExact('DOGE:PEPE');
        assert.strictEqual(id, 41);
        assert.deepStrictEqual(inserts, [{ id: 41, tick: 'DOGE:PEPE', block_index: 901 }]);
        assert.strictEqual(rows.length, 2);
        assert.strictEqual(internCache.tick.size, 0, 'the case-folded intern cache is never touched');
    });

    it('returns the same id on a second call without a new insert', async function () {
        const { db, inserts } = harness();
        const first  = await db.createTickerExact('DOGE:PEPE', 905);
        const second = await db.createTickerExact('DOGE:PEPE', 906);
        assert.strictEqual(first, 41);
        assert.strictEqual(second, 41);
        assert.strictEqual(inserts.length, 1);
        assert.strictEqual(inserts[0].block_index, 905);
    });

    it('resolves the exact-case row without inserting', async function () {
        const { db, inserts } = harness();
        assert.strictEqual(await db.createTickerExact('doge:pepe'), 40);
        assert.strictEqual(inserts.length, 0);
    });

    it('inserts nothing and returns null in the rollback refresh phase', async function () {
        const { db, inserts } = harness();
        db.suppressIndexIdCreation = true;
        assert.strictEqual(await db.createTickerExact('DOGE:PEPE'), null);
        assert.strictEqual(inserts.length, 0);
    });

    it('returns null when the insert is ignored and no exact row exists', async function () {
        const { db, inserts } = harness();
        db.ignoreInserts = true;
        assert.strictEqual(await db.createTickerExact('DOGE:PEPE'), null);
        assert.strictEqual(inserts.length, 1);
    });

    it('resolves carets without getTickerId or the case-folded intern cache', async function () {
        const { db, inserts } = harness();
        db.getTickerId = async function () {
            throw new Error('createTickerExact delegated to cache-capable getTickerId');
        };
        Object.defineProperty(db, '_internCache', {
            get(){
                throw new Error('createTickerExact read the case-folded intern cache');
            },
        });

        assert.strictEqual(await db.createTickerExact(null), null);
        assert.strictEqual(await db.createTickerExact('^40'), 40);
        assert.strictEqual(await db.createTickerExact('^999'), null);
        assert.strictEqual(await db.createTickerExact('^040'), null);
        assert.strictEqual(inserts.length, 0);
    });
});
