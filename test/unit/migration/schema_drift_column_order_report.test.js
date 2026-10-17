'use strict';

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
 * Column-ORDER drift report for the startup reconciler.
 *
 * The legacy 2026-05-29 runbooks added dispensers and sweeps columns with a bare
 * ADD COLUMN, so aged tables hold them at the tail while a fresh install puts them
 * mid-table. alterTableForDrift() must name those columns in the shape-drift store
 * (and so in the SCHEMA SHAPE DRIFT boot line) and must never move them itself.
 *
 ********************************************************************/

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const Database = require('../../../src/db');

const SQL_DIR = path.join(__dirname, '..', '..', '..', 'src', 'sql');

// The real source's declared column names, in source order.
function sourceColumns(table) {
    const sql = fs.readFileSync(path.join(SQL_DIR, table + '.sql'), 'utf8');
    return Database.prototype.parseExpectedColumns.call(Database.prototype, sql).map(c => c.name);
}

// Live rows with ORDINAL_POSITION from the given order, returned shuffled so the
// report has to sort by position rather than trust the row order.
function liveRows(order) {
    const rows = order.map((name, i) => ({
        COLUMN_NAME: name, IS_NULLABLE: 'YES', COLUMN_TYPE: 'varchar(256)', COLUMN_KEY: '', EXTRA: '',
        ORDINAL_POSITION: i + 1
    }));
    return rows.filter((r, i) => i % 2 === 1).concat(rows.filter((r, i) => i % 2 === 0));
}

// alterTableForDrift over a mocked live table, with a shape-drift store to read back.
async function runReport(table, order) {
    const queries = [];
    const ctx = { dbName: 'xchain_test', schemaShapeDrift: new Map(),
                  parseExpectedColumns: Database.prototype.parseExpectedColumns,
                  stripSqlLineComments: Database.prototype.stripSqlLineComments,
                  undeclaredLiveColumns: Database.prototype.undeclaredLiveColumns };
    const db = { query: async (sql) => {
        queries.push(sql);
        return /information_schema\.columns/i.test(sql) ? liveRows(order) : [];
    } };
    await Database.prototype.alterTableForDrift.call(ctx, table + '.sql', db);
    return { entry: ctx.schemaShapeDrift.get(table), alters: queries.filter(q => /^\s*ALTER TABLE/i.test(q)) };
}

// Source order with the named columns moved to the tail, as a bare ADD COLUMN leaves them.
function tailAppended(table, tail) {
    const cols = sourceColumns(table);
    for (const name of tail) assert.ok(cols.includes(name), table + '.sql no longer declares ' + name);
    return cols.filter(c => !tail.includes(c)).concat(tail);
}

const DISPENSERS_TAIL = ['give_ownership', 'fiat_id', 'fiat_amount', 'oracle_address_id'];
const SWEEPS_TAIL     = ['orders', 'swaps', 'dispensers'];

describe('alterTableForDrift(): column-order drift report @regression', function () {

    it('names exactly the four tail-appended dispensers columns and issues no ALTER', async function () {
        const { entry, alters } = await runReport('dispensers', tailAppended('dispensers', DISPENSERS_TAIL));
        assert.ok(entry, 'expected a shape-drift entry for dispensers');
        assert.deepStrictEqual(entry.columnOrder, DISPENSERS_TAIL);
        assert.deepStrictEqual(alters, [], 'the reconciler must never reposition a column itself');
    });

    it('names exactly the three tail-appended sweeps columns', async function () {
        const { entry, alters } = await runReport('sweeps', tailAppended('sweeps', SWEEPS_TAIL));
        assert.deepStrictEqual(entry && entry.columnOrder, SWEEPS_TAIL);
        assert.deepStrictEqual(alters, []);
    });

    it('records nothing for a table already in source order', async function () {
        const { entry } = await runReport('dispensers', sourceColumns('dispensers'));
        assert.strictEqual(entry, undefined);
    });

    it('ignores an undeclared live column placed mid-table (reported as undeclared, not misordered)', async function () {
        const order = sourceColumns('sweeps');
        order.splice(3, 0, 'escrows');
        const { entry } = await runReport('sweeps', order);
        assert.deepStrictEqual(entry.columns, ['escrows']);
        assert.strictEqual(entry.columnOrder, undefined);
    });
});

describe('schemaShapeSummary(): column-order drift line @regression', function () {

    it('reports a table whose only drift is column order as drift, naming the columns', function () {
        const inst = Object.create(Database.prototype);
        inst.schemaShapeDrift = new Map([['dispensers', { columns: [], indexes: [], indexKinds: [], columnOrder: DISPENSERS_TAIL }]]);
        const summary = inst.schemaShapeSummary();
        assert.ok(/^SCHEMA SHAPE DRIFT: 1 table\(s\)/.test(summary), summary);
        assert.ok(/4 declared column\(s\) out of source order/.test(summary), summary);
        assert.ok(summary.includes('columns out of source order ' + DISPENSERS_TAIL.join(', ')), summary);
    });
});
