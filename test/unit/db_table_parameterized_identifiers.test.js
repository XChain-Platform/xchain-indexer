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
 * test/unit/db_table_parameterized_identifiers.test.js
 *
 * The misc mixin's table-parameterized reads and writes splice a caller-supplied
 * table or column name straight into the statement, because an identifier cannot
 * be a bound parameter. Backtick quoting alone is not a defence: a name that
 * itself contains a backtick closes the quote and the rest of the name becomes
 * SQL. So the shape assertion is the whole guard, and these cases hold it.
 *
 * The negative control is that the connection stub records every statement it is
 * handed: a refused call must leave that recording EMPTY, which is what separates
 * "rejected before the query" from "rejected by the server afterwards".
 */

'use strict';

const assert = require('assert');
const misc   = require('../../src/db/misc');
const escrowJournal = require('../../src/db/escrow_journal');
const writer = require('../../src/consensus/escrowJournalWriter');

// A recording connection. Nothing here validates anything, so any statement that
// reaches `issued` got past the guard under test.
function recordingDb(){
    const issued = [];
    const db = { issued, async doQuery(sql, args){ issued.push({ sql, args }); return []; } };
    for(const m of ['listTableColumnNames', 'countRowsInTable', 'readAllRowsByFirstColumn', 'insertRowsIntoTable'])
        db[m] = misc[m].bind(db);
    return db;
}

// Names that break out of backtick quoting, plus the plain non-string cases.
const HOSTILE = ['tokens`; DROP TABLE tokens; --', 'tokens WHERE 1=1', 'to kens', '', 'tokens;'];

describe('db misc mixin: table-parameterized identifiers @regression', function () {

    it('refuses a hostile TABLE name before issuing anything', async function () {
        for(const bad of HOSTILE){
            const db = recordingDb();
            await assert.rejects(() => db.countRowsInTable(bad), /invalid SQL identifier/,
                'countRowsInTable accepted ' + JSON.stringify(bad));
            await assert.rejects(() => db.listTableColumnNames(bad), /invalid SQL identifier/,
                'listTableColumnNames accepted ' + JSON.stringify(bad));
            await assert.rejects(() => db.readAllRowsByFirstColumn(bad, ['id']), /invalid SQL identifier/,
                'readAllRowsByFirstColumn accepted ' + JSON.stringify(bad));
            await assert.rejects(() => db.insertRowsIntoTable(bad, ['id'], [[1]]), /invalid SQL identifier/,
                'insertRowsIntoTable accepted ' + JSON.stringify(bad));
            assert.deepEqual(db.issued, [], 'a refused identifier must issue no statement at all');
        }
    });

    it('refuses a hostile COLUMN name too, not just the table', async function () {
        const db = recordingDb();
        await assert.rejects(() => db.readAllRowsByFirstColumn('tokens', ['id', 'x`,(SELECT 1)']),
            /invalid SQL identifier/);
        await assert.rejects(() => db.insertRowsIntoTable('tokens', ['id', 'x`,1'], [[1, 2]]),
            /invalid SQL identifier/);
        assert.deepEqual(db.issued, []);
    });

    it('refuses a non-string identifier rather than stringifying it', async function () {
        const db = recordingDb();
        for(const bad of [null, undefined, 7, {}, ['tokens']])
            await assert.rejects(() => db.countRowsInTable(bad), /invalid SQL identifier/,
                'accepted ' + JSON.stringify(bad));
        assert.deepEqual(db.issued, []);
    });

    it('passes a well-formed identifier through and binds every value', async function () {
        const db = recordingDb();
        await db.insertRowsIntoTable('tokens', ['id', 'tick_id'], [[1, 5], [2, 6]]);
        assert.equal(db.issued.length, 1, 'two rows go out as ONE multi-row INSERT');
        assert.equal(db.issued[0].sql, 'INSERT INTO `tokens` (`id`,`tick_id`) VALUES (?,?),(?,?)');
        assert.deepEqual(db.issued[0].args, [1, 5, 2, 6]);

        // The order clause carries one ordinal per selected column, never ordinal 1 alone:
        // a table whose first column repeats (credits, sends, rollcall_gates) would otherwise
        // leave the dump's row order, and so its sha256, up to the engine.
        await db.readAllRowsByFirstColumn('tokens', ['id', 'tick_id']);
        assert.equal(db.issued[1].sql, 'SELECT `id`,`tick_id` FROM `tokens` ORDER BY 1 ASC, 2 ASC');
    });

    it('countRowsInTable reads zero from an empty result rather than NaN', async function () {
        const db = { async doQuery(){ return []; } };
        db.countRowsInTable = misc.countRowsInTable.bind(db);
        assert.strictEqual(await db.countRowsInTable('tokens'), 0);
    });

});

describe('db escrow_journal mixin: the dispenser-family identifiers @regression', function () {

    // Both the TABLE and the FOREIGN KEY COLUMN vary by dispenser action, so both are
    // spliced. They come from the frozen DISPENSER_FAMILY map, and the assertion is what
    // keeps that the only thing they can be.
    function recordingDb(){
        const issued = [];
        const db = { issued, async doQuery(sql, args){ issued.push({ sql, args }); return []; } };
        db.getDispenserFamilyReference = escrowJournal.getDispenserFamilyReference.bind(db);
        return db;
    }

    it('refuses a hostile table or column and issues nothing', async function () {
        for(const bad of ['dispensers; DROP TABLE escrows', 'dispensers`', 'a b', '', null, 7]){
            const db = recordingDb();
            await assert.rejects(() => db.getDispenserFamilyReference(bad, 'action_index', 1),
                /invalid SQL identifier/, 'table accepted ' + JSON.stringify(bad));
            await assert.rejects(() => db.getDispenserFamilyReference('dispensers', bad, 1),
                /invalid SQL identifier/, 'column accepted ' + JSON.stringify(bad));
            assert.deepEqual(db.issued, [], 'a refused identifier must issue no statement');
        }
    });

    it('every frozen DISPENSER_FAMILY entry passes the assertion and binds its action', async function () {
        const db = recordingDb();
        for(const action of Object.keys(writer.DISPENSER_FAMILY)){
            const spec = writer.DISPENSER_FAMILY[action];
            await db.getDispenserFamilyReference(spec.table, spec.fk, 42);
        }
        assert.equal(db.issued.length, Object.keys(writer.DISPENSER_FAMILY).length);
        for(const q of db.issued){
            assert.match(q.sql, /^SELECT [A-Za-z0-9_]+ AS dispenser_action_index FROM [A-Za-z0-9_]+ WHERE action_index = \?$/);
            assert.deepEqual(q.args, [42]);
        }
    });

});
