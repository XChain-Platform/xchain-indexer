'use strict';

/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * Two db reads behind the dispenser and list-edit flag-days, with doQuery stubbed:
 * the edit overlays of getDispenserInfo / getOrderInfo / getSwapInfo turn a stored
 * list edit of 0 into "no list" while a positive id still replaces and a blank still
 * keeps, and hasProvenUseBefore reads only the three kinds of proven use.
 */

const assert   = require('assert');
const Database = require('../../../../src/db');
const Utility  = require('../../../../src/utility');

// A Database-shaped `this`: the real prototype, a stub doQuery that answers the base
// row query with `base` and the edits query with `edits`, and fixed remaining amounts.
function fakeDb(base, edits, editsTable) {
    const db = Object.create(Database.prototype);
    db.config = { COIN: 'BTC', DISPENSER_LIST_DELAY: 3600 };
    db.util = new Utility();
    db.doQuery = async (q) => (q.includes(editsTable) ? edits : [base]);
    db.getOrderAmountsRemaining = async () => ['1', '1'];
    db.getDispenserAmountRemaining = async () => '1';
    return db;
}

// One edit row as each edits query selects it; dispenser edits carry the block_time
// their one-hour list delay is measured from.
function editRow(allow, block) {
    return { expiration: null, allow_list: allow, block_list: block, block_time: 0 };
}

const READERS = [
    { name: 'getDispenserInfo', table: 'dispenser_edits', call: (db) => db.getDispenserInfo('BTC', 50, 100000) },
    { name: 'getOrderInfo',     table: 'order_edits',     call: (db) => db.getOrderInfo('BTC', 42) },
    { name: 'getSwapInfo',      table: 'swap_edits',      call: (db) => db.getSwapInfo('BTC', 10) },
];

for (const r of READERS) {
    describe(r.name + '() list edit overlay @regression @tier1', function () {
        const base = { action_index: 1, allow_list: 7, block_list: 8, give_amount: '1', get_amount: '1' };

        it('an edit of 0 removes the list, reading as the 0 a never-listed row has', async function () {
            const info = await r.call(fakeDb(base, [editRow(0, 0)], r.table));
            assert.strictEqual(info['ALLOW_LIST'], 0);
            assert.strictEqual(info['BLOCK_LIST'], 0);
        });

        it('a positive list id still replaces and a blank still keeps', async function () {
            const info = await r.call(fakeDb(base, [editRow(9, null)], r.table));
            assert.strictEqual(info['ALLOW_LIST'], 9);
            assert.strictEqual(info['BLOCK_LIST'], 8);
        });

        it('the last valid edit wins: a removal followed by a new list reads the new list', async function () {
            const info = await r.call(fakeDb(base, [editRow(0, null), editRow(11, null)], r.table));
            assert.strictEqual(info['ALLOW_LIST'], 11);
        });
    });
}

describe('hasProvenUseBefore() @regression @tier1', function () {
    async function capture(address, blockIndex, rows) {
        const cap = {};
        const db = { doQuery: async (q, a) => { cap.query = q; cap.args = a; return rows; } };
        cap.result = await Database.prototype.hasProvenUseBefore.call(db, address, blockIndex);
        return cap;
    }

    it('counts SOURCE of an action, a credit, and a valid dispenser GET_ADDRESS, each strictly before the block', async function () {
        const cap = await capture('addr1', 500, []);
        const q = cap.query.replace(/\s+/g, ' ');
        assert.ok(/FROM actions x1 WHERE x1\.source_id=a1\.id AND x1\.block_index < \?/.test(q), 'SOURCE of an action');
        assert.ok(/FROM credits c1 INNER JOIN actions x2 ON \(x2\.action_index=c1\.action_index\) WHERE c1\.address_id=a1\.id AND x2\.block_index < \?/.test(q), 'a credit');
        assert.ok(/FROM dispensers d1 .*d1\.get_address_id=a1\.id AND s1\.status='valid' AND x3\.block_index < \?/.test(q), 'a valid dispenser on the address');
        assert.deepStrictEqual(cap.args, ['addr1', 500, 500, 500]);
        assert.strictEqual(cap.result, false);
    });

    it('never reads LIST items, the mention that made the old verdict griefable', async function () {
        const cap = await capture('addr1', 500, []);
        assert.ok(!/list_items/.test(cap.query));
        assert.ok(!/index_addresses[^\n]*block_index/.test(cap.query), 'the interning block of the address row is not evidence');
    });

    it('answers true when any evidence row exists', async function () {
        const cap = await capture('addr1', 500, [{ id: 3 }]);
        assert.strictEqual(cap.result, true);
    });
});
