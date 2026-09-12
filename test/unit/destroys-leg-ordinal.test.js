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
 * test/unit/destroys-leg-ordinal.test.js
 *
 * A multi-destroy writes ONE ROW PER LEG under one action_index. Until
 * leg_ordinal existed, the broadcast order of those legs was stored nowhere:
 * a reader either sorted on a value column (which reorders the legs against
 * the transaction) or leaned on physical insertion order, which SQL does not
 * guarantee. leg_ordinal is that position, stamped by createDestroy from the
 * order the action loop settles the legs.
 *
 * Technique: run the real createDestroy against an in-memory table simulator
 * that returns rows in a DELIBERATELY SHUFFLED order, then assert that
 * sorting the result by leg_ordinal reproduces the wire. A simulator that
 * hands rows back in insertion order would let the old, orderless code pass.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../fixtures/config');
const Utility           = require('../../src/utility');
const Database          = require('../../src/db');

// Split a SELECT/VALUES expression list on its TOP-LEVEL commas, so
// `COALESCE(MAX(leg_ordinal) + 1, 0)` stays one expression.
function splitExpressions(list) {
    const out = [];
    let depth = 0, current = '';
    for (const ch of String(list)) {
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        if (ch === ',' && depth === 0) { out.push(current.trim()); current = ''; continue; }
        current += ch;
    }
    if (current.trim()) out.push(current.trim());
    return out;
}

// Apply an INSERT to the in-memory rows, storing in each column exactly what the
// STATEMENT puts there. A column the statement never writes stays absent from the row,
// which is the whole point: the pre-fix INSERT wrote no ordinal, and this simulator must
// reproduce that rather than helpfully number the rows itself.
function insertRow(rows, sql, args) {
    const cols   = splitExpressions(sql.slice(sql.indexOf('(') + 1, sql.indexOf(')')));
    const select = sql.match(/\)\s*SELECT([\s\S]*?)\bFROM\b/i);
    const values = sql.match(/\bVALUES?\s*\(([\s\S]*)\)\s*$/i);
    const exprs  = splitExpressions(select ? select[1] : (values ? values[1] : ''));

    const row = {};
    let arg = 0, ordinalColumn = null;
    exprs.forEach((expr, i) => {
        const col = cols[i];
        if (expr === '?') { row[col] = args[arg++]; return; }
        if (/^COALESCE\(\s*MAX\(\s*leg_ordinal\s*\)\s*\+\s*1\s*,\s*0\s*\)$/i.test(expr)) { ordinalColumn = col; return; }
        throw new Error('unsupported INSERT expression in test simulator: ' + expr);
    });
    if (ordinalColumn) {
        // Whatever args are left bind the subselect's own WHERE, whose first (and only)
        // parameter is the action_index the aggregate is scoped to.
        const action_index = args[arg];
        const prior = rows.filter(r => r.action_index === action_index).map(r => Number(r.leg_ordinal));
        row[ordinalColumn] = prior.length ? Math.max.apply(null, prior) + 1 : 0;
    }
    rows.push(row);
    return { affectedRows: 1 };
}

// In-memory stand-in for one leg table. Understands the three statement shapes
// createDestroy/createSend emit, including the `INSERT ... SELECT ..., COALESCE(MAX
// (leg_ordinal)+1, 0) FROM <table> WHERE action_index=?` form that assigns the ordinal.
function makeTable(keyColumns) {
    const rows = [];

    const matches = (row, where) => Object.keys(where).every(k => {
        const a = row[k] === undefined ? null : row[k];
        const b = where[k] === undefined ? null : where[k];
        return a === b;
    });

    return {
        rows,
        // Rows come back in an order that is neither insertion nor reverse insertion,
        // standing in for the engine's freedom to return them however it likes.
        shuffled() {
            const out = rows.slice();
            if (out.length > 2) out.unshift(out.pop());
            return out.reverse();
        },
        query(sql, args) {
            const kind = sql.trim().slice(0, 6).toUpperCase();
            if (kind === 'SELECT') {
                const where = {};
                keyColumns.forEach((col, i) => { where[col] = args[i]; });
                return rows.filter(r => matches(r, where));
            }
            if (kind === 'INSERT') return insertRow(rows, sql, args);
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
    sinon.stub(db, 'createTicker').callsFake(async tick => ids.tick[tick]);
    sinon.stub(db, 'createMemo').callsFake(async memo => (memo === '' || memo == null) ? null : ids.memo[memo]);
    sinon.stub(db, 'createStatus').callsFake(async () => 1);
    sinon.stub(db, 'createAddress').callsFake(async addr => ids.address[addr]);
    return db;
}

// Read the legs the way a corrected consumer does: ORDER BY leg_ordinal.
const byOrdinal = (rows) => rows.slice().sort((a, b) => a.leg_ordinal - b.leg_ordinal);

describe('destroys leg ordinal @regression', function () {

    afterEach(() => sinon.restore());

    it('recovers broadcast order from leg_ordinal when the rows come back shuffled', async function () {
        const table = makeTable(['action_index', 'tick_id', 'memo_id']);
        const db    = makeDb(table, { tick: { AAA: 11, BBB: 22, CCC: 33 }, memo: {}, address: {} });

        const wire = [['AAA', '1'], ['BBB', '2'], ['CCC', '3']];
        for (const [tick, amount] of wire)
            await db.createDestroy({ ACTION_INDEX: 800, TICK: tick, AMOUNT: amount, MEMO: '', STATUS: 'valid' });

        const shuffled = table.shuffled();
        assert.notDeepStrictEqual(shuffled.map(r => r.amount), ['1', '2', '3'],
            'the simulator must hand rows back out of order, or this test proves nothing');
        assert.deepStrictEqual(byOrdinal(shuffled).map(r => r.amount), ['1', '2', '3'],
            'ordering by leg_ordinal must reproduce the broadcast');
    });

    it('numbers the legs of one action 0..n-1 and restarts per action', async function () {
        const table = makeTable(['action_index', 'tick_id', 'memo_id']);
        const db    = makeDb(table, { tick: { AAA: 11, BBB: 22, CCC: 33 }, memo: {}, address: {} });

        for (const tick of ['AAA', 'BBB', 'CCC'])
            await db.createDestroy({ ACTION_INDEX: 810, TICK: tick, AMOUNT: '1', MEMO: '', STATUS: 'valid' });
        for (const tick of ['AAA', 'BBB'])
            await db.createDestroy({ ACTION_INDEX: 811, TICK: tick, AMOUNT: '1', MEMO: '', STATUS: 'valid' });

        const legs = (idx) => byOrdinal(table.rows.filter(r => r.action_index === idx)).map(r => r.leg_ordinal);
        assert.deepStrictEqual(legs(810), [0, 1, 2]);
        assert.deepStrictEqual(legs(811), [0, 1], 'the ordinal is per action, not a global counter');
    });

    it('separates same-TICK legs by memo and keeps their wire positions apart', async function () {
        const table = makeTable(['action_index', 'tick_id', 'memo_id']);
        const db    = makeDb(table, { tick: { AAA: 11 }, memo: { first: 7, second: 8 }, address: {} });

        await db.createDestroy({ ACTION_INDEX: 820, TICK: 'AAA', AMOUNT: '1', MEMO: 'first',  STATUS: 'valid' });
        await db.createDestroy({ ACTION_INDEX: 820, TICK: 'AAA', AMOUNT: '2', MEMO: 'second', STATUS: 'valid' });

        assert.deepStrictEqual(byOrdinal(table.rows).map(r => [r.leg_ordinal, r.memo_id]), [[0, 7], [1, 8]]);
    });

    it('a re-parse rewrites a leg\'s values without moving it on the wire', async function () {
        const table = makeTable(['action_index', 'tick_id', 'memo_id']);
        const db    = makeDb(table, { tick: { AAA: 11, BBB: 22 }, memo: {}, address: {} });

        const wire = [['AAA', '1'], ['BBB', '2']];
        for (const [tick, amount] of wire)
            await db.createDestroy({ ACTION_INDEX: 830, TICK: tick, AMOUNT: amount, MEMO: '', STATUS: 'valid' });
        // Rollback-then-reindex replays the same action; the legs already exist, so each
        // one takes the UPDATE branch, which must leave leg_ordinal alone.
        for (const [tick, amount] of wire)
            await db.createDestroy({ ACTION_INDEX: 830, TICK: tick, AMOUNT: amount, MEMO: '', STATUS: 'valid' });

        assert.strictEqual(table.rows.length, 2, 'a re-parse must not duplicate legs');
        assert.deepStrictEqual(byOrdinal(table.rows).map(r => [r.leg_ordinal, r.tick_id]), [[0, 11], [1, 22]]);
    });
});
