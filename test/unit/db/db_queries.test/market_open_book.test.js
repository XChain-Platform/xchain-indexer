/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/db/db_queries.test/market_open_book.test.js
 *
 * getMarketInfo ranks the best bid and the best ask from one read of the open book.
 *
 * Part of the Database query suite (see ../db_queries.test.js): real method
 * logic against a stubbed doQuery, no live MariaDB required.
 */

'use strict';

const assert = require('assert');
const sinon  = require('sinon');

const { makeDb } = require('./helpers/db_stub');

const getMarketInfoOn = (db) => db.getMarketInfo(1, 1000000);

afterEach(() => sinon.restore());

describe('Database.getMarketInfo() open-book ranking', function () {
    // The two-reader ranking the merged reader replaced, kept as the oracle: one loop per
    // extreme over the same rows, each with its own initialise-from-first-non-zero rule.
    function oracle(util, data, rows, sideOf, cmp) {
        let best1 = 0, best2 = 0;
        for (const row of rows) {
            const give = (sideOf(row.give_tick_id) === data.tick1_id) ? row.give_amount : row.get_amount;
            const get  = (sideOf(row.give_tick_id) === data.tick1_id) ? row.get_amount  : row.give_amount;
            const p1 = util.getPrice(get, give), p2 = util.getPrice(give, get);
            if (p1 == 0 || p2 == 0) continue;
            if (best1 == 0) best1 = p1;
            if (best2 == 0) best2 = p2;
            if (util[cmp](p1, best1)) best1 = p1;
            if (util[cmp](p2, best2)) best2 = p2;
        }
        return [String(best1), String(best2)];
    }

    // A book with equal prices, a zero-amount row, a '10' vs '9' pair and both give/get orientations.
    const BOOKS = {
        'token/token': { tick1_id: 10, tick2_id: 20, rows: [
            { give_tick_id: 10, give_amount: '1', get_tick_id: 20, get_amount: '9' },
            { give_tick_id: 20, give_amount: '10', get_tick_id: 10, get_amount: '1' },
            { give_tick_id: 10, give_amount: '0', get_tick_id: 20, get_amount: '5' },
            { give_tick_id: 10, give_amount: '2', get_tick_id: 20, get_amount: '18' },
            { give_tick_id: 20, give_amount: '3', get_tick_id: 10, get_amount: '7' }] },
        'native/token': { tick1_id: 0, tick2_id: 20, rows: [
            { give_tick_id: null, give_amount: '1', get_tick_id: 20, get_amount: '10' },
            { give_tick_id: 20, give_amount: '9', get_tick_id: null, get_amount: '1' },
            { give_tick_id: null, give_amount: '4', get_tick_id: 20, get_amount: '0' },
            { give_tick_id: 20, give_amount: '0.5', get_tick_id: null, get_amount: '0.25' }] }
    };

    for (const [name, book] of Object.entries(BOOKS)) {
        it('matches the separate bid and ask rankings on a ' + name + ' book', async function () {
            const db = makeDb();
            const q  = sinon.stub(db, 'doQuery');
            q.onCall(0).resolves([{ market_id: 1, tick1: 'AAA', tick1_id: book.tick1_id, tick1_decimals: 8,
                                    tick2: 'BBB', tick2_id: book.tick2_id, tick2_decimals: 8,
                                    coin1_id: 1, coin2_id: 1 }]);
            q.onCall(1).resolves([]);
            q.onCall(2).resolves([]);
            q.onCall(3).resolves(book.rows);
            q.onCall(4).resolves([]);
            const data   = await getMarketInfoOn(db);
            const sideOf = (id) => require('../../../../src/db').marketTickId(id);
            const side   = { tick1_id: book.tick1_id };
            assert.deepStrictEqual([String(data.tick1_bid), String(data.tick2_bid)], oracle(db.util, side, book.rows, sideOf, 'bcgt'));
            assert.deepStrictEqual([String(data.tick1_ask), String(data.tick2_ask)], oracle(db.util, side, book.rows, sideOf, 'bclt'));
            assert.strictEqual(q.callCount, 5, 'the open book is read once for both rankings');
        });
    }
});
