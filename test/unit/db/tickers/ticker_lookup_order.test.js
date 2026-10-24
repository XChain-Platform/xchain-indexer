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
const fs     = require('fs');
const path   = require('path');

const tickerQueries = require('../../../../src/db/index_tables/tickers.js');
const tickerSchema  = fs.readFileSync(path.join(__dirname, '../../../../src/sql/index_tickers.sql'), 'utf8');

function harness(results){
    const queries = [];
    const db = {
        util: { isNull: value => value === null || value === undefined || value === '' },
        _internCache: null,
        async doQuery(sql, args){
            queries.push({ sql, args });
            return results;
        },
    };
    Object.assign(db, tickerQueries);
    return { db, queries };
}

// A transaction-context createTicker fake over in-memory rows. It models utf8mb4_bin
// PAD SPACE equality and the unique tick prefix declared in src/sql/index_tickers.sql.
function prefixKeyDb(rows){
    const padEq = (a, b) => a.replace(/ +$/, '') === b.replace(/ +$/, '');
    const prefixMatch = /CREATE UNIQUE INDEX tick on index_tickers \(tick\((\d+)\)\)/.exec(tickerSchema);
    const uniquePrefix = prefixMatch ? Number(prefixMatch[1]) : Infinity;
    const db = {
        config: { NETWORK: 'regtest', COIN: 'BTC' },
        util: { isNull: value => value === null || value === undefined || value === '' },
        _internCache: null,
        transactionConnection: { id: 1 },
        blockIndex: 11,
        suppressIndexIdCreation: false,
        async doQuery(sql, args){
            if(sql.includes('WHERE LOWER(tick)=?')){
                const row = rows.find(item => padEq(item.tick.toLowerCase(), args[0]));
                return row ? [{ id: row.id }] : [];
            }
            if(sql.includes('WHERE LEFT(tick, 200)=LEFT(?, 200) AND tick LIKE ?')){
                const likePrefix = args[1].slice(0, -1).replace(/!(.)/g, '$1');
                const row = rows.find(item => item.tick.startsWith(likePrefix) &&
                    padEq(item.tick.slice(0, 200), args[0].slice(0, 200)));
                return row ? [{ id: row.id }] : [];
            }
            if(sql.includes('ORDER BY id DESC LIMIT 1 FOR UPDATE'))
                return [{ id: rows[rows.length - 1].id }];
            if(sql.includes('INSERT IGNORE INTO index_tickers')){
                const [id, tick, block_index] = args;
                const collision = rows.some(item =>
                    padEq(item.tick.slice(0, uniquePrefix), tick.slice(0, uniquePrefix)));
                if(!collision)
                    rows.push({ id, tick, block_index });
                return { affectedRows: collision ? 0 : 1 };
            }
            throw new Error('Unexpected query: ' + sql);
        },
    };
    return Object.assign(db, tickerQueries);
}

// Runs body below the activation and then with the regtest arming variable at 0,
// restoring the variable afterwards.
async function belowThenArmed(below, armed){
    const saved = process.env.XC_TICK_NORMALIZE_REGTEST_ACTIVATION;
    try {
        delete process.env.XC_TICK_NORMALIZE_REGTEST_ACTIVATION;
        await below();
        process.env.XC_TICK_NORMALIZE_REGTEST_ACTIVATION = '0';
        await armed();
    } finally {
        if(saved === undefined) delete process.env.XC_TICK_NORMALIZE_REGTEST_ACTIVATION;
        else process.env.XC_TICK_NORMALIZE_REGTEST_ACTIVATION = saved;
    }
}

describe('Database createTicker legacy tick(200) key @unit @regression', function () {
    it('assigns distinct ids to accepted names that differ after character 200', async function () {
        const prefix = 'A'.repeat(200);
        const rows = [{ id: 7, tick: prefix + 'X', block_index: 10 }];
        const db = prefixKeyDb(rows);
        await belowThenArmed(async () => {
            assert.strictEqual(await db.createTicker(prefix + 'Y'), null);
            assert.strictEqual(await db.createTicker(prefix), null);
            assert.strictEqual(rows.length, 1);
        }, async () => {
            assert.strictEqual(await db.createTicker(prefix + 'Y'), 8);
            assert.strictEqual(await db.createTicker(prefix), 9);
            assert.strictEqual(rows.length, 3);
        });
    });

    it('keeps the space-padded tick(200) collision of a shorter name below activation', async function () {
        // Under the former tick(200) key a 150-character name equals a stored name whose
        // characters 151 to 200 are spaces.
        const rows = [{ id: 7, tick: 'X'.repeat(150) + ' '.repeat(50) + 'Y', block_index: 10 }];
        const db = prefixKeyDb(rows);
        await belowThenArmed(async () => {
            assert.strictEqual(await db.createTicker('X'.repeat(150)), null);
            assert.strictEqual(rows.length, 1);
        }, async () => {
            assert.strictEqual(await db.createTicker('X'.repeat(150)), 8);
            assert.strictEqual(rows.length, 2);
        });
    });
});

describe('Database getTickerId lookup order @unit @regression', function () {
    it('maps every ASCII case spelling and a subasset spelling to one folded lookup key', async function () {
        const spellings = ['ALPHA', 'Alpha', 'alpha', 'PARENT.Child', 'parent.child'];
        const seen = [];
        const db = {
            util: { isNull: value => value === null || value === undefined || value === '' },
            _internCache: null,
            async doQuery(sql, args){
                seen.push({ sql, args });
                return [{ id: args[0] === 'alpha' ? 7 : 11 }];
            },
        };
        Object.assign(db, tickerQueries);

        const ids = [];
        for(const spelling of spellings)
            ids.push(await db.getTickerId(spelling));

        assert.deepStrictEqual(ids, [7, 7, 7, 11, 11]);
        assert.deepStrictEqual(seen.map(call => call.args[0]),
            ['alpha', 'alpha', 'alpha', 'parent.child', 'parent.child']);
        assert.ok(seen.every(call => call.sql.includes('ORDER BY id ASC LIMIT 1')));
    });

    it('rejects every non-canonical caret boundary without selecting a numeric id', async function () {
        const spellings = ['^0', '^007', '^+7', '^-7', '^ 7', '^7 ', '^1.0', '^1e3', '^0x10', '^'];
        for(const spelling of spellings){
            const { db } = harness([]);
            assert.strictEqual(await db.getTickerId(spelling), null, spelling);
        }
    });

    it('orders a case-insensitive name lookup by ascending id and returns the first row', async function () {
        const { db, queries } = harness([{ id: 7 }, { id: 19 }]);

        assert.strictEqual(await db.getTickerId('DOGE:PEPE'), 7);
        assert.deepStrictEqual(queries, [{
            sql: 'SELECT id FROM index_tickers WHERE LOWER(tick)=? ORDER BY id ASC LIMIT 1',
            args: ['doge:pepe'],
        }]);
    });

    it('returns null when a name lookup misses', async function () {
        const { db, queries } = harness([]);

        assert.strictEqual(await db.getTickerId('DOGE:PEPE'), null);
        assert.deepStrictEqual(queries, [{
            sql: 'SELECT id FROM index_tickers WHERE LOWER(tick)=? ORDER BY id ASC LIMIT 1',
            args: ['doge:pepe'],
        }]);
    });

    it('keeps canonical caret lookups on the id query', async function () {
        const { db, queries } = harness([{ id: 42 }]);

        assert.strictEqual(await db.getTickerId('^42'), 42);
        assert.deepStrictEqual(queries, [{
            sql: 'SELECT id FROM index_tickers WHERE id=? AND block_index IS NOT NULL LIMIT 1',
            args: ['42'],
        }]);
    });
});
