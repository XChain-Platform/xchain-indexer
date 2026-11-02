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
 * test/regression/prefixed_integer_refused_rows.test.js
 *
 * A refused row binds an integer column only a value the column stores.
 *
 * Every handler below writes its row whatever its verdict, and the writer bound the
 * integer wire fields as carried. A hexadecimal, binary or octal literal survives storage
 * normalization (it is numeric and inside the column's range), and a strict session
 * refuses it (errno 1265), so one refused action halted every indexer: the live case was
 * DISPENSER|0|BTC|NOTICK|1||1|BTC||0.0001|||||0x10, refused as GIVE_TICK unknown, whose
 * dispensers.expiration bind of '0x10' failed. Each writer now fits a refused row's
 * literal to the integer it names. No reader of these columns brings a refused row into a
 * verdict or a hash, so the fitted value is display data only.
 *
 * Every row runs the real writer with doQuery stubbed and checks each bound value
 * against a strict-conversion model read from the shipped DDL. The controls: a valid row
 * binds its values unchanged, and a refused row binds every spelling the column already
 * converts ('1e12', '+100', '00100') unchanged.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../fixtures/config');
const Utility           = require('../../src/utility');
const Database          = require('../../src/db');
const { columnAccepts } = require('../helpers/strict_columns.js');

// Writer, the wire fields it binds into integer columns, and the table those columns are in.
const SITES = [
    ['createDispenser',             'dispensers',      ['EXPIRATION', 'ALLOW_LIST', 'BLOCK_LIST']],
    ['createDispenserEdit',         'dispenser_edits', ['EXPIRATION', 'ALLOW_LIST', 'BLOCK_LIST']],
    ['createOrder',                 'orders',          ['EXPIRATION', 'ALLOW_LIST', 'BLOCK_LIST']],
    ['createOrderEdit',             'order_edits',     ['EXPIRATION', 'ALLOW_LIST', 'BLOCK_LIST']],
    ['createSwap',                  'swaps',           ['EXPIRATION', 'ALLOW_LIST', 'BLOCK_LIST']],
    ['createSwapEdit',              'swap_edits',      ['EXPIRATION', 'ALLOW_LIST', 'BLOCK_LIST']],
    ['createBetFeed',               'bet_feeds',       ['DEADLINE', 'REFUND_WINDOW', 'ALLOW_LIST', 'BLOCK_LIST']],
    ['createBet',                   'bets',            ['FEED_ACTION_INDEX', 'OUTCOME']],
    ['createBetCancel',             'bet_cancels',     ['FEED_ACTION_INDEX']],
    ['createBetResolve',            'bet_resolves',    ['FEED_ACTION_INDEX', 'OUTCOME']],
    ['createBetEdit',               'bet_edits',       ['FEED_ACTION_INDEX', 'ALLOW_LIST', 'BLOCK_LIST']],
    ['createBroadcast',             'broadcasts',      ['BROADCAST_ACTION_INDEX']],
    ['createLink',                  'links',           ['COIN1_ACTION_INDEX', 'COIN2_ACTION_INDEX']],
    ['createAirdrop',               'airdrops',        ['LIST_ACTION_INDEX']],
    ['createListMeta',              'list_metas',      ['LIST_ACTION_INDEX']],
    ['createIssue',                 'issues',          ['ALLOW_LIST', 'BLOCK_LIST']],
    ['createCrossChainCallRequest', 'xcalls',          ['TARGET_CONTRACT_INDEX']]
];

// Each spelling and the integer a refused row binds for it.
const PREFIXED = [['0x10', '16'], ['0X1f', '31'], ['0b101', '5'], ['0o17', '15']];
// Spellings the column converts itself, inside every listed column's range except '1e12',
// which OUTCOME's INT UNSIGNED bound sends to normalization's NULL as it always did.
const DECIMAL  = ['1e12', '1e3', '+100', '00100', '7'];

// The column a positional bind lands in, read from the statement's column list and
// VALUES (or SELECT) list, split on top-level commas.
function splitTop(text){
    const out = [];
    let depth = 0, cur = '';
    for(const ch of text){
        if(ch === '(') depth++;
        if(ch === ')') depth--;
        if(ch === ',' && depth === 0){ out.push(cur); cur = ''; continue; }
        cur += ch;
    }
    if(cur.trim()) out.push(cur);
    return out;
}

function enclosed(text, open){
    let depth = 0;
    for(let i = open; i < text.length; i++){
        if(text[i] === '(') depth++;
        if(text[i] === ')' && --depth === 0) return text.slice(open + 1, i);
    }
    return text.slice(open + 1);
}

// { column: boundValue } for one INSERT, or null for any other statement.
function insertBinds(sql, args){
    const head = /INSERT\s+INTO\s+`?(\w+)`?\s*\(/i.exec(sql);
    if(!head) return null;
    const open = head.index + head[0].length - 1;
    const columnText = enclosed(sql, open);
    const columns = splitTop(columnText).map(c => c.trim());
    const rest = sql.slice(open + columnText.length + 2);
    const values = /^\s*VALUES\s*\(/i.exec(rest);
    const terms = splitTop(values ? enclosed(rest, values[0].length - 1) : rest.replace(/^\s*SELECT\s+/i, '').split(/\sFROM\s/i)[0]);
    const binds = {};
    let arg = 0;
    terms.forEach((term, i) => {
        const marks = (term.match(/\?/g) || []).length;
        if(marks === 1) binds[columns[i]] = args[arg];
        arg += marks;
    });
    return { table: head[1], binds };
}

function makeDb(){
    const util = new Utility();
    sinon.stub(util, 'logError');
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config: getTestConfig(), util });
    const inserts = [];
    sinon.stub(db, 'doQuery').callsFake(async (sql, args) => {
        const insert = insertBinds(String(sql).replace(/\s+/g, ' '), args || []);
        if(insert) inserts.push(insert);
        return /^\s*SELECT/i.test(sql) ? [] : { insertId: 3, affectedRows: 1 };
    });
    return { db, inserts };
}

// Run one writer with every listed field set to `value`; returns the bound columns.
async function bindsFor(writer, table, fields, value, status){
    const { db, inserts } = makeDb();
    const data = { STATUS: status, ACTION_INDEX: 40, BLOCK_INDEX: 30, SOURCE: 'source', TICK: 'TEST' };
    for(const field of fields) data[field] = value;
    await db[writer](data);
    const row = inserts.find(insert => insert.table === table);
    assert.ok(row, writer + ' wrote no ' + table + ' row');
    return row.binds;
}

afterEach(function(){ sinon.restore(); });

describe('refused rows bind integer columns only values they store @regression @tier1', function(){
    for(const [writer, table, fields] of SITES){
        it(writer + ' fits a prefixed literal on a refused ' + table + ' row', async function(){
            for(const [spelling, integer] of PREFIXED){
                const binds = await bindsFor(writer, table, fields, spelling, 'invalid: probe');
                for(const field of fields){
                    const column = field.toLowerCase();
                    const bound = binds[column];
                    assert.strictEqual(String(bound), integer, table + '.' + column + ' for ' + spelling);
                    assert.ok(columnAccepts(table, column, bound), table + '.' + column + ' refuses ' + bound);
                }
            }
        });

        it(writer + ' binds a converted spelling as normalization left it on a refused ' + table + ' row', async function(){
            const { db } = makeDb();
            for(const spelling of DECIMAL){
                const binds = await bindsFor(writer, table, fields, spelling, 'invalid: probe');
                for(const field of fields){
                    const normalized = db.normalizeDataValues({ STATUS: 'invalid: probe', [field]: spelling })[field];
                    assert.strictEqual(binds[field.toLowerCase()], normalized, table + '.' + field + ' for ' + spelling);
                    if(field !== 'OUTCOME') assert.strictEqual(normalized, spelling, field + ' ' + spelling);
                }
            }
        });
    }

    it('leaves a valid row as its handler admitted it', async function(){
        const binds = await bindsFor('createDispenser', 'dispensers', ['EXPIRATION'], '0x10', 'valid');
        assert.strictEqual(binds['expiration'], '0x10');
        const kept = await bindsFor('createOrder', 'orders', ['EXPIRATION'], '1700000000', 'valid');
        assert.strictEqual(kept['expiration'], '1700000000');
    });
});
