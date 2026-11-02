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
 *
 * test/unit/db/text_width/helpers/strict_db.js
 *
 * A Database whose doQuery behaves like the strict MariaDB session the indexer pins, over
 * the text columns the column-width suites write: an over-width bind fails with errno 1406,
 * a supplementary-plane character bound to a utf8mb3 column fails with errno 1366 (1267 on
 * an index-table lookup), and INSERT IGNORE cuts the value instead of failing.
 */

'use strict';

const sinon = require('sinon');

const { getTestConfig }     = require('../../../../fixtures/config');
const Utility               = require('../../../../../src/utility');
const Database              = require('../../../../../src/db');
const { exceedsCodePoints } = require('../../../../../src/db/column_text.js');

const EMOJI = '\u{1F600}';
const FFFD  = '�';

// Column widths and charsets as src/sql/ declares them; true marks a utf8mb3 column.
const COLUMNS = {
    index_coins:   { coin: [250, true] },
    index_fiats:   { code: [250, true] },
    index_pubkeys: { pubkey: [64, true] },
    xcalls:   { call_id: [80, true], target_chain: [10, true], method: [64, false], callback_method: [64, false] },
    messages: { coin: [4, false], encryption_method: [1, false] },
    issues:   { decimals: [2, false], callback_block: [15, false], mint_start_block: [15, false],
                mint_stop_block: [15, false], bridge_chains: [250, false], min_depth: [15, false],
                lock_bridge: [1, false] },
    prices:   { value: [250, false], fee: [250, false] },
    bet_feeds: { label: [250, false], outcomes: [1100, false], fee: [11, false] }
};

function hasSupplementary(v){
    return typeof v === 'string' && [...v].some((c) => c.codePointAt(0) > 0xFFFF);
}

function serverError(errno, message){
    const err = new Error(message);
    err.errno = errno;
    return err;
}

// SELECT id FROM index_<x> WHERE <col>=?: a 4-byte bind against utf8mb3 throws.
function lookup(state, table, column, value){
    if(COLUMNS[table] && COLUMNS[table][column][1] && hasSupplementary(value))
        throw serverError(1267, 'Illegal mix of collations');
    const rows = state.interned[table] || new Map();
    return rows.has(String(value)) ? [{ id: rows.get(String(value)) }] : [];
}

// INSERT IGNORE INTO index_<x>: the server cuts the value to the column and does not fail.
function internIgnore(state, table, column, value){
    const stored = [...String(value)].slice(0, COLUMNS[table][column][0]).join('');
    state.interned[table] = state.interned[table] || new Map();
    if(!state.interned[table].has(stored)) state.interned[table].set(stored, state.nextId++);
    return {};
}

// INSERT INTO <table> (cols): every checked column must fit, or the statement fails.
function insertRow(state, table, columnList, args){
    const row = {};
    columnList.split(',').map((c) => c.trim()).forEach((name, i) => { row[name] = args[i]; });
    for(const name of Object.keys(COLUMNS[table] || {})){
        const [width, mb3] = COLUMNS[table][name];
        if(row[name] === null || row[name] === undefined) continue;
        if(mb3 && hasSupplementary(String(row[name])))
            throw serverError(1366, 'Incorrect string value for column ' + name);
        if(exceedsCodePoints(row[name], width))
            throw serverError(1406, 'Data too long for column ' + name);
    }
    state.inserts[table] = row;
    return {};
}

function strictQuery(state, sql, args = []){
    let m = /^\s*SELECT id FROM (index_\w+) WHERE `?(\w+)`?=\?/i.exec(sql);
    if(m) return lookup(state, m[1], m[2], args[0]);
    m = /^\s*INSERT IGNORE INTO (index_\w+) \(`?(\w+)`?\)/i.exec(sql);
    if(m) return internIgnore(state, m[1], m[2], args[0]);
    m = /^\s*INSERT INTO (\w+)\s*\(([^)]*)\)/i.exec(sql);
    if(m) return insertRow(state, m[1], m[2], args);
    return [];
}

// A Database with doQuery replaced by the strict stub and the id interners it does not
// exercise stubbed to id 1. Returns the database and the state the stub records into.
function strictDb(){
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', {
        config: getTestConfig(),
        util:   new Utility()
    });
    const state = { interned: {}, inserts: {}, nextId: 1 };
    sinon.stub(db, 'doQuery').callsFake(async (sql, args) => strictQuery(state, sql, args));
    for(const name of ['createStatus', 'createTicker', 'createAddress', 'createMemo', 'getAddressId'])
        sinon.stub(db, name).resolves(1);
    return { db, interned: state.interned, inserts: state.inserts };
}

module.exports = { EMOJI, FFFD, strictDb };
