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
 * test/unit/db_xbridge_writers.test/helpers/writer_db.js
 *
 * The table simulator and the real-Database harness every db_xbridge_writers
 * suite drives the two XBRIDGE writers through. Kept in one place so the entry
 * file and its parts bind rows exactly the same way.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const sinon = require('sinon');

const Utility  = require('../../../../src/utility.js');
const configjs = require('../../../../src/config.js');
const Database = require('../../../../src/db');

const SOURCE      = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const DEST        = 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM';
const BRIDGE_DOGE = 'mxchainbridgedogeXXXXXXXXXXXXXXXXX';

// In-memory stand-in for one table. Understands only the statement shapes the two
// writers emit, and binds args positionally exactly as those methods pass them, so the
// test cannot drift from the writer's own binding.
function makeTable(name, keyColumns){
    const rows = [];

    const matches = (row, where) => Object.keys(where).every(k => {
        const a = row[k] === undefined ? null : row[k];
        const b = where[k] === undefined ? null : where[k];
        return a === b;
    });

    return {
        name,
        rows,
        query(sql, args){
            const kind = sql.trim().slice(0, 6).toUpperCase();
            if(kind === 'SELECT'){
                const where = {};
                keyColumns.forEach((col, i) => { where[col] = args[i]; });
                return rows.filter(r => matches(r, where));
            }
            if(kind === 'INSERT'){
                // Column order is read out of the statement itself.
                const cols = sql.slice(sql.indexOf('(') + 1, sql.indexOf(')')).split(',').map(s => s.trim());
                const row  = {};
                cols.forEach((col, i) => { row[col] = args[i]; });
                rows.push(row);
                return { affectedRows: 1 };
            }
            if(kind === 'UPDATE')
                return applyUpdate(rows, matches, sql, args);
            throw new Error('unexpected statement in test simulator: ' + sql);
        }
    };
}

// The UPDATE statement shape for one simulated table: the SET columns bind the
// leading args in order, the WHERE columns bind the rest, and the matching rows
// are changed in place.
function applyUpdate(rows, matches, sql, args){
    const setCols   = sql.slice(sql.indexOf('SET') + 3, sql.indexOf('WHERE'))
        .split(',').map(s => s.trim().replace(/=\?$/, '').replace(/=\d+$/, '')).filter(Boolean);
    // A literal assignment (`bridged=1`) binds no argument, so it is applied
    // from the statement text; only `col=?` consumes a positional arg.
    const literals  = {};
    sql.slice(sql.indexOf('SET') + 3, sql.indexOf('WHERE'))
        .split(',').map(s => s.trim())
        .forEach(frag => {
            const m = frag.match(/^([a-z_]+)=(\d+)$/);
            if(m) literals[m[1]] = Number(m[2]);
        });
    const bound     = setCols.filter(c => !(c in literals));
    const whereFrags = sql.slice(sql.indexOf('WHERE') + 5).split(/\s+AND\s+/).map(s => s.trim());
    const whereCols = [];
    const whereLits = {};
    for(const frag of whereFrags){
        const lit = frag.match(/^([a-z_]+)\s*=\s*(\d+)$/);
        if(lit){ whereLits[lit[1]] = Number(lit[2]); continue; }
        const col = (frag.match(/([a-z_]+)\s*(?:=|<=>)\s*\?/) || [])[1];
        if(col) whereCols.push(col);
    }
    const setArgs   = args.slice(0, bound.length);
    const whereArgs = args.slice(bound.length);
    const where     = Object.assign({}, whereLits);
    whereCols.forEach((col, i) => { where[col] = whereArgs[i]; });
    const hit = rows.filter(r => matches(r, where));
    for(const row of hit){
        bound.forEach((col, i) => { row[col] = setArgs[i]; });
        Object.keys(literals).forEach(col => { row[col] = literals[col]; });
    }
    return { affectedRows: hit.length };
}

// A real Database whose doQuery routes to whichever simulated table the statement names,
// and whose four lookup interners hand back stable, distinct ids per value.
function makeDb(tables, ids){
    const config = configjs.getConfig('BTC', 'regtest');
    const util   = new Utility(config);
    const db     = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config, util });
    sinon.stub(db, 'doQuery').callsFake(async (sql, args) => {
        for(const table of tables)
            if(new RegExp('\\b' + table.name + '\\b').test(sql))
                return table.query(sql, args);
        throw new Error('no simulated table for: ' + sql);
    });
    const intern = (map, prefix) => async value => {
        if(value === null || value === undefined || value === '') return null;
        const key = String(value);
        if(!(key in map)) map[key] = prefix + (Object.keys(map).length + 1);
        return map[key];
    };
    ids.tick    = ids.tick    || {};
    ids.address = ids.address || {};
    ids.memo    = ids.memo    || {};
    ids.status  = ids.status  || {};
    sinon.stub(db, 'createTicker').callsFake(intern(ids.tick, 100));
    sinon.stub(db, 'createAddress').callsFake(intern(ids.address, 200));
    sinon.stub(db, 'createMemo').callsFake(intern(ids.memo, 300));
    sinon.stub(db, 'createStatus').callsFake(intern(ids.status, 400));
    return db;
}

// The row shape actions/xbridge.js hands createXbridge: the raw wire clone plus the
// three fields the apply path stamps onto it.
function xbridgeRow(overrides){
    return Object.assign({
        ACTION:       'XBRIDGE',
        ACTION_INDEX: 42,
        BLOCK_INDEX:  100,
        SOURCE:       SOURCE,
        MEMO:         '',
        STATUS:       'valid'
    }, overrides || {});
}

module.exports = { SOURCE, DEST, BRIDGE_DOGE, makeTable, makeDb, xbridgeRow };
