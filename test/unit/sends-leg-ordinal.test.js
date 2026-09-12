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
 * test/unit/sends-leg-ordinal.test.js
 *
 * The sends half of the leg-ordinal work (the destroys half, with the shared
 * reasoning, is in destroys-leg-ordinal.test.js): a multi-send writes one row
 * per leg under one action_index, and leg_ordinal is the only record of which
 * leg came first on the wire.
 *
 * The schema cases at the bottom cover BOTH tables, because the guarantee this
 * item exists to make is a schema guarantee: a leg's position is a stored
 * column with an index behind it, on the fresh-install path and the migration
 * path alike, not an artifact of how rows happened to land on a page.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const sinon  = require('sinon');

const { getTestConfig } = require('../fixtures/config');
const Utility           = require('../../src/utility');
const Database          = require('../../src/db');

const SQL_DIR = path.join(__dirname, '..', '..', 'src', 'sql');
const MIG     = path.join(SQL_DIR, 'migrations', '2026-09-13-destroys-sends-leg-ordinal.sql');

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
// STATEMENT puts there. A column the statement never writes stays absent from the row:
// the pre-fix INSERT wrote no ordinal, and the simulator must reproduce that rather than
// number the rows on the writer's behalf.
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
        const action_index = args[arg];
        const prior = rows.filter(r => r.action_index === action_index).map(r => Number(r.leg_ordinal));
        row[ordinalColumn] = prior.length ? Math.max.apply(null, prior) + 1 : 0;
    }
    rows.push(row);
    return { affectedRows: 1 };
}

function makeTable(keyColumns) {
    const rows = [];

    const matches = (row, where) => Object.keys(where).every(k => {
        const a = row[k] === undefined ? null : row[k];
        const b = where[k] === undefined ? null : where[k];
        return a === b;
    });

    return {
        rows,
        // Neither insertion nor reverse-insertion order: the engine owes a reader
        // nothing without an ORDER BY, and this stands in for that freedom.
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

const byOrdinal = (rows) => rows.slice().sort((a, b) => a.leg_ordinal - b.leg_ordinal);

const SEND_KEY = ['tick_id', 'destination_id', 'amount', 'action_index'];

describe('sends leg ordinal @regression', function () {

    afterEach(() => sinon.restore());

    it('recovers broadcast order from leg_ordinal when the rows come back shuffled', async function () {
        const table = makeTable(SEND_KEY);
        const db    = makeDb(table, {
            tick:    { AAA: 11, BBB: 22, CCC: 33 },
            memo:    {},
            address: { addr1: 101, addr2: 102, addr3: 103 }
        });

        const wire = [
            { TICK: 'AAA', AMOUNT: '1', DESTINATION: 'addr1' },
            { TICK: 'BBB', AMOUNT: '2', DESTINATION: 'addr2' },
            { TICK: 'CCC', AMOUNT: '3', DESTINATION: 'addr3' }
        ];
        for (const leg of wire)
            await db.createSend({ ACTION_INDEX: 900, MEMO: '', STATUS: 'valid', ...leg });

        const shuffled = table.shuffled();
        assert.notDeepStrictEqual(shuffled.map(r => r.amount), ['1', '2', '3'],
            'the simulator must hand rows back out of order, or this test proves nothing');
        assert.deepStrictEqual(byOrdinal(shuffled).map(r => r.amount), ['1', '2', '3'],
            'ordering by leg_ordinal must reproduce the broadcast');
    });

    it('numbers the legs of one action 0..n-1 and restarts per action', async function () {
        const table = makeTable(SEND_KEY);
        const db    = makeDb(table, { tick: { AAA: 11 }, memo: {}, address: { addr1: 101, addr2: 102 } });

        for (const dest of ['addr1', 'addr2'])
            await db.createSend({ ACTION_INDEX: 910, TICK: 'AAA', AMOUNT: '1', DESTINATION: dest, MEMO: '', STATUS: 'valid' });
        await db.createSend({ ACTION_INDEX: 911, TICK: 'AAA', AMOUNT: '1', DESTINATION: 'addr1', MEMO: '', STATUS: 'valid' });

        const legs = (idx) => byOrdinal(table.rows.filter(r => r.action_index === idx)).map(r => r.leg_ordinal);
        assert.deepStrictEqual(legs(910), [0, 1]);
        assert.deepStrictEqual(legs(911), [0], 'the ordinal is per action, not a global counter');
    });

    it('a re-parse rewrites a leg\'s values without moving it on the wire', async function () {
        const table = makeTable(SEND_KEY);
        const db    = makeDb(table, { tick: { AAA: 11, BBB: 22 }, memo: {}, address: { addr1: 101, addr2: 102 } });

        const wire = [
            { TICK: 'AAA', AMOUNT: '1', DESTINATION: 'addr1' },
            { TICK: 'BBB', AMOUNT: '2', DESTINATION: 'addr2' }
        ];
        for (const leg of wire)
            await db.createSend({ ACTION_INDEX: 920, MEMO: '', STATUS: 'valid', ...leg });
        for (const leg of wire)
            await db.createSend({ ACTION_INDEX: 920, MEMO: '', STATUS: 'valid', ...leg });

        assert.strictEqual(table.rows.length, 2, 'a re-parse must not duplicate legs');
        assert.deepStrictEqual(byOrdinal(table.rows).map(r => [r.leg_ordinal, r.tick_id]), [[0, 11], [1, 22]]);
    });
});

describe('destroys/sends leg ordinal is a SCHEMA guarantee @regression', function () {

    const definition = (table) => fs.readFileSync(path.join(SQL_DIR, table + '.sql'), 'utf8');
    const migration  = fs.readFileSync(MIG, 'utf8');

    for (const table of ['destroys', 'sends']) {

        it(table + ' declares leg_ordinal NOT NULL with a default, so every row has a position', function () {
            const sql = definition(table);
            const col = sql.match(/^\s*leg_ordinal\s+([^\n,]*)/mi);
            assert.ok(col, table + '.sql declares no leg_ordinal column');
            assert.match(col[1], /NOT NULL/i, 'a nullable position is no position');
            assert.match(col[1], /DEFAULT\s+0/i, 'rows written before the column existed must land on 0, not NULL');
        });

        it(table + ' indexes (action_index, leg_ordinal) so the ordered read is served by an index', function () {
            const sql = definition(table);
            const idx = new RegExp('CREATE\\s+INDEX\\s+\\w+\\s+ON\\s+' + table + '\\s*\\(\\s*action_index\\s*,\\s*leg_ordinal\\s*\\)', 'i');
            assert.match(sql, idx, 'no composite (action_index, leg_ordinal) index declared for ' + table);
        });

        it(table + ' gains the same column and index on the migration path, anchored to the same position', function () {
            const add = new RegExp('ALTER\\s+TABLE\\s+' + table + '\\s+ADD\\s+COLUMN\\s+IF\\s+NOT\\s+EXISTS\\s+leg_ordinal([^;]*)', 'i');
            const m = migration.match(add);
            assert.ok(m, 'the dated migration does not add leg_ordinal to ' + table +
                '; an aged database would never gain it, and the two schema paths diverge');
            assert.match(m[1], /NOT NULL\s+DEFAULT\s+0/i, 'the migration must land the same column shape as the definition');
            assert.match(m[1], /AFTER\s+status_id/i,
                'the definition declares leg_ordinal last, so the migration must anchor it there too or ' +
                'SHOW CREATE TABLE stops matching a fresh install');
            const idx = new RegExp('CREATE\\s+INDEX\\s+IF\\s+NOT\\s+EXISTS\\s+\\w+\\s+ON\\s+' + table +
                '\\s*\\(\\s*action_index\\s*,\\s*leg_ordinal\\s*\\)', 'i');
            assert.match(migration, idx, 'the migration must create the composite index on ' + table + ' too');
        });
    }
});
