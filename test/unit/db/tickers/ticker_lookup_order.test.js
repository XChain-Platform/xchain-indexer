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

const tickerQueries = require('../../../../src/db/index_tables/tickers.js');

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

describe('Database getTickerId lookup order @unit @regression', function () {
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
        assert.strictEqual(queries.length, 1);
        assert.match(queries[0].sql, /WHERE LOWER\(tick\)=\? ORDER BY id ASC LIMIT 1/);
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
