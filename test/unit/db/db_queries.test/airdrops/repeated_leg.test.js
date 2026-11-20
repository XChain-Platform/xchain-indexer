/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************/

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { makeDb } = require('../helpers/db_stub');

afterEach(function () {
    sinon.restore();
});

// Columns named by a `col=?` list joined by commas (SET) or AND (WHERE), in bind order.
function placeholderColumns(clause){
    return clause.split(/,|\sAND\s/i).map(part => part.trim()).filter(Boolean)
        .map(part => part.replace(/\s*=\s*\?$/, ''));
}

// SQL `col = ?` is never true when either side is NULL.
function rowMatches(row, columns, values){
    return columns.every((column, i) => values[i] != null && row[column] === values[i]);
}

// Applies whatever statement text createAirdrop sends, binding args by the column order
// the text itself declares, so the table reflects the SQL actually issued.
function runAirdropSql(rows, sql, args){
    const text = String(sql).replace(/\s+/g, ' ').trim();
    let match = text.match(/^INSERT INTO airdrops \(([^)]*)\) values/i);
    if(match) {
        const row = {};
        placeholderColumns(match[1]).forEach((column, i) => { row[column] = args[i]; });
        rows.push(row);
        return [];
    }
    match = text.match(/^UPDATE airdrops SET (.*) WHERE (.*)$/i);
    if(match) {
        const setColumns = placeholderColumns(match[1]);
        const whereValues = args.slice(setColumns.length);
        for(const row of rows.filter(r => rowMatches(r, placeholderColumns(match[2]), whereValues)))
            setColumns.forEach((column, i) => { row[column] = args[i]; });
        return [];
    }
    match = text.match(/^SELECT action_index FROM airdrops WHERE (.*)$/i);
    if(match)
        return rows.filter(row => rowMatches(row, placeholderColumns(match[1]), args))
            .map(row => ({ action_index: row.action_index }));
    throw new Error(`unrecognised airdrops statement: ${text}`);
}

function makeStateDb(){
    const db = makeDb();
    const rows = [];
    sinon.stub(db, 'createTicker').callsFake(tick => Promise.resolve({ GAS: 1, BRRR: 2 }[tick]));
    sinon.stub(db, 'createMemo').resolves(3);
    sinon.stub(db, 'createStatus').callsFake(status => Promise.resolve(status === 'valid' ? 10 : 11));
    sinon.stub(db, 'doQuery').callsFake((sql, args) => Promise.resolve(runAirdropSql(rows, sql, args)));
    return { db, rows };
}

describe('Database.createAirdrop() repeated legs @regression @tier1', function () {
    it('keeps sibling rows intact when an exact leg repeats', async function () {
        // The table model must be able to show the overwrite: an action-only UPDATE
        // rewrites every row of the action.
        const control = [{ tick_id: 1, amount: '1', status_id: 10, action_index: 80 },
                         { tick_id: 2, amount: '2', status_id: 10, action_index: 80 }];
        runAirdropSql(control, 'UPDATE airdrops SET tick_id=?, amount=?, status_id=? WHERE action_index=?',
            [1, '1', 11, 80]);
        assert.deepStrictEqual(control[1], { tick_id: 1, amount: '1', status_id: 11, action_index: 80 });

        const { db, rows } = makeStateDb();
        const base = { ACTION_INDEX: 80, LIST_ACTION_INDEX: 1234, MEMO: 'hello' };
        await db.createAirdrop(Object.assign({}, base, { TICK: 'GAS', AMOUNT: '1', STATUS: 'valid' }));
        await db.createAirdrop(Object.assign({}, base, { TICK: 'BRRR', AMOUNT: '2', STATUS: 'valid' }));
        await db.createAirdrop(Object.assign({}, base,
            { TICK: 'GAS', AMOUNT: '1', STATUS: 'invalid: insufficient funds' }));

        assert.deepStrictEqual(rows.find(row => row.tick_id === 2), {
            tick_id: 2, list_action_index: 1234, amount: '2', memo_id: 3, status_id: 10, action_index: 80
        });
    });
});
