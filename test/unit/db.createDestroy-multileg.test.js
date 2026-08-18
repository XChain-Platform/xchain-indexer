/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/db.createDestroy-multileg.test.js
 *
 * A multi-destroy (DESTROY FORMAT 1/2) burns several TICK legs under ONE
 * ACTION_INDEX, the same shape a multi-send has always had. createDestroy keyed
 * its exists-check AND its UPDATE on action_index alone, so leg 2 matched leg 1's
 * row and overwrote it: an N-tick destroy left ONE destroys row, carrying the last
 * leg's TICK and AMOUNT. Balances were never wrong (the action loop debits per leg
 * in memory), so this is the destroys READ MODEL - the explorer/API destroy lists,
 * which under-reported every multi-destroy.
 *
 * createSend had the mirror-image defect on its UPDATE leg: the exists-check was
 * already per-leg but the UPDATE said `WHERE action_index=?`, so a re-parse of a
 * block stamped one leg's values over every other leg of the same send, and the
 * legs it had just clobbered then failed their own exists-check and INSERTed
 * duplicates.
 *
 * Technique: drive the real methods against an in-memory table simulator behind
 * doQuery, and assert the RESULTING ROWS rather than the SQL text - the failure
 * this class of bug produces is a row count, and a SQL-text assertion would pass
 * for any WHERE clause that merely mentions the right column.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../fixtures/config');
const Utility           = require('../../src/utility');
const Database          = require('../../src/db');

// Minimal in-memory stand-in for one action table. Understands only the three
// statement shapes createDestroy/createSend emit, and binds args positionally
// exactly as those methods pass them.
function makeTable(keyColumns) {
    const rows = [];

    // NULL-safe match, mirroring the `<=>` the queries use for memo_id.
    const matches = (row, where) => Object.keys(where).every(k => {
        const a = row[k] === undefined ? null : row[k];
        const b = where[k] === undefined ? null : where[k];
        return a === b;
    });

    return {
        rows,
        query(sql, args) {
            const kind = sql.trim().slice(0, 6).toUpperCase();
            if (kind === 'SELECT') {
                const where = {};
                keyColumns.forEach((col, i) => { where[col] = args[i]; });
                return rows.filter(r => matches(r, where));
            }
            if (kind === 'INSERT') {
                // INSERT column order is taken from the statement itself so the test
                // cannot drift from the method's own binding.
                const cols = sql.slice(sql.indexOf('(') + 1, sql.indexOf(')')).split(',').map(s => s.trim());
                const row  = {};
                cols.forEach((col, i) => { row[col] = args[i]; });
                rows.push(row);
                return { affectedRows: 1 };
            }
            if (kind === 'UPDATE') {
                const setCols   = sql.slice(sql.indexOf('SET') + 3, sql.indexOf('WHERE'))
                    .split(',').map(s => s.trim().replace(/=\?$/, '')).filter(Boolean);
                const whereCols = sql.slice(sql.indexOf('WHERE'))
                    .split(/\s+AND\s+/).map(s => (s.match(/([a-z_]+)\s*(?:=|<=>)\s*\?/) || [])[1])
                    .filter(Boolean);
                const setArgs   = args.slice(0, setCols.length);
                const whereArgs = args.slice(setCols.length);
                const where     = {};
                whereCols.forEach((col, i) => { where[col] = whereArgs[i]; });
                const hit = rows.filter(r => matches(r, where));
                for (const row of hit) setCols.forEach((col, i) => { row[col] = setArgs[i]; });
                return { affectedRows: hit.length };
            }
            throw new Error('unexpected statement in test simulator: ' + sql);
        }
    };
}

function makeDb(table, ids) {
    const config = getTestConfig();
    const util   = new Utility();
    sinon.stub(util, 'logError');
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config, util });
    sinon.stub(db, 'doQuery').callsFake(async (sql, args) => table.query(sql, args));
    // Lookup tables are exercised elsewhere; here they only need to be stable and
    // distinct per value so leg identity is expressible.
    sinon.stub(db, 'createTicker').callsFake(async tick => ids.tick[tick]);
    sinon.stub(db, 'createMemo').callsFake(async memo => (memo === '' || memo == null) ? null : ids.memo[memo]);
    sinon.stub(db, 'createStatus').callsFake(async () => 1);
    sinon.stub(db, 'createAddress').callsFake(async addr => ids.address[addr]);
    return db;
}

describe('createDestroy() - multi-destroy legs', function () {

    afterEach(() => sinon.restore());

    it('writes ONE ROW PER TICK LEG of a multi-destroy sharing one action_index', async function () {
        const table = makeTable(['action_index', 'tick_id', 'memo_id']);
        const db    = makeDb(table, { tick: { AAA: 11, BBB: 22, CCC: 33 }, memo: {}, address: {} });

        for (const [tick, amount] of [['AAA', '1'], ['BBB', '2'], ['CCC', '3']])
            await db.createDestroy({ ACTION_INDEX: 500, TICK: tick, AMOUNT: amount, MEMO: '', STATUS: 'valid' });

        assert.strictEqual(table.rows.length, 3, 'a 3-tick destroy must leave 3 destroys rows');
        assert.deepStrictEqual(
            table.rows.map(r => [r.tick_id, r.amount]).sort((a, b) => a[0] - b[0]),
            [[11, '1'], [22, '2'], [33, '3']],
            'each leg keeps its own TICK and AMOUNT'
        );
    });

    it('separates legs of the same TICK carrying different memos (FORMAT 2)', async function () {
        const table = makeTable(['action_index', 'tick_id', 'memo_id']);
        const db    = makeDb(table, { tick: { AAA: 11 }, memo: { first: 7, second: 8 }, address: {} });

        await db.createDestroy({ ACTION_INDEX: 501, TICK: 'AAA', AMOUNT: '1', MEMO: 'first',  STATUS: 'valid' });
        await db.createDestroy({ ACTION_INDEX: 501, TICK: 'AAA', AMOUNT: '2', MEMO: 'second', STATUS: 'valid' });

        assert.strictEqual(table.rows.length, 2);
        assert.deepStrictEqual(table.rows.map(r => [r.memo_id, r.amount]), [[7, '1'], [8, '2']]);
    });

    it('re-parsing the same block updates each leg in place instead of duplicating or clobbering', async function () {
        const table = makeTable(['action_index', 'tick_id', 'memo_id']);
        const ids   = { tick: { AAA: 11, BBB: 22 }, memo: {}, address: {} };
        const db    = makeDb(table, ids);

        const legs = [['AAA', '1'], ['BBB', '2']];
        for (const [tick, amount] of legs)
            await db.createDestroy({ ACTION_INDEX: 502, TICK: tick, AMOUNT: amount, MEMO: '', STATUS: 'valid' });
        // Second pass over the same action, as a rollback-then-reindex produces.
        for (const [tick, amount] of legs)
            await db.createDestroy({ ACTION_INDEX: 502, TICK: tick, AMOUNT: amount, MEMO: '', STATUS: 'valid' });

        assert.strictEqual(table.rows.length, 2, 'a re-parse must not duplicate legs');
        assert.deepStrictEqual(table.rows.map(r => [r.tick_id, r.amount]), [[11, '1'], [22, '2']]);
    });

    it('keeps destroys of the same TICK under DIFFERENT actions as separate rows', async function () {
        const table = makeTable(['action_index', 'tick_id', 'memo_id']);
        const db    = makeDb(table, { tick: { AAA: 11 }, memo: {}, address: {} });

        await db.createDestroy({ ACTION_INDEX: 600, TICK: 'AAA', AMOUNT: '1', MEMO: '', STATUS: 'valid' });
        await db.createDestroy({ ACTION_INDEX: 601, TICK: 'AAA', AMOUNT: '2', MEMO: '', STATUS: 'valid' });

        assert.strictEqual(table.rows.length, 2);
    });
});

describe('createSend() - multi-send legs', function () {

    afterEach(() => sinon.restore());

    it('does not let a re-parse stamp one leg over every other leg of the same send', async function () {
        const table = makeTable(['tick_id', 'destination_id', 'amount', 'action_index']);
        const db    = makeDb(table, {
            tick:    { AAA: 11, BBB: 22 },
            memo:    {},
            address: { addr1: 101, addr2: 102 }
        });

        const legs = [
            { TICK: 'AAA', AMOUNT: '1', DESTINATION: 'addr1' },
            { TICK: 'BBB', AMOUNT: '2', DESTINATION: 'addr2' }
        ];
        for (const leg of legs)
            await db.createSend({ ACTION_INDEX: 700, MEMO: '', STATUS: 'valid', ...leg });
        for (const leg of legs)
            await db.createSend({ ACTION_INDEX: 700, MEMO: '', STATUS: 'valid', ...leg });

        assert.strictEqual(table.rows.length, 2, 'a re-parse must neither clobber nor duplicate send legs');
        assert.deepStrictEqual(
            table.rows.map(r => [r.tick_id, r.destination_id, r.amount]),
            [[11, 101, '1'], [22, 102, '2']]
        );
    });
});
