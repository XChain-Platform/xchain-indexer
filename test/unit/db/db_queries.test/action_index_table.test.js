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
 * test/unit/db/db_queries.test/action_index_table.test.js
 *
 * The action_index to status-table resolution behind LINK and BROADCAST
 * references: an action with no status-bearing table of its own resolves to
 * no table (an invalid reference) instead of reaching SQL with a table name
 * that does not exist, an error that halts the block.
 *
 * Part of the Database query suite (see ../db_queries.test.js): real method
 * logic against a stubbed doQuery, no live MariaDB required.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const sinon  = require('sinon');

const { makeDb, dbWithDoQuery } = require('./helpers/db_stub');

const SQL_DIR  = path.join(__dirname, '../../../../src/sql');
const ES_NAMES = ['address', 'batch', 'dispense'];

afterEach(function () {
    sinon.restore();
});

// The action name the pluralizer needs to produce `table`, or null when no name can
function actionForTable(table) {
    if (table.endsWith('es') && ES_NAMES.includes(table.slice(0, -2)))
        return table.slice(0, -2);
    if (table.endsWith('s') && !ES_NAMES.includes(table.slice(0, -1)))
        return table.slice(0, -1);
    return null;
}

// Every table file in src/sql with whether it carries the two columns the status query reads
function schemaTables() {
    return fs.readdirSync(SQL_DIR).filter((f) => f.endsWith('.sql')).map((file) => {
        const sql = fs.readFileSync(path.join(SQL_DIR, file), 'utf8');
        return {
            table:     file.slice(0, -4),
            hasStatus: /^\s*`?action_index`?\s/m.test(sql) && /^\s*`?status_id`?\s/m.test(sql)
        };
    });
}

describe('Database.getActionIndexTable() status-table allowlist @regression @tier1', function () {
    // A DEPLOY has no `deploys` table (its rows live in `contracts`), so its pluralized
    // name must never reach SQL, where the 1146 error would halt the block.
    it('returns null for an action whose pluralized table does not exist', async function () {
        for (const action of ['deploy', 'execute', 'withdraw', 'delegate', 'anchor', 'collect', 'unknown']) {
            const db = dbWithDoQuery([{ action }]);
            assert.strictEqual(await db.getActionIndexTable(5), null, action);
            sinon.restore();
        }
    });

    // `rollcalls` exists but carries neither action_index nor status_id, so the status
    // query failed on an unknown column instead of a missing table: the same halt.
    it('returns null for an action whose table has no status row', async function () {
        const db = dbWithDoQuery([{ action: 'rollcall' }]);
        assert.strictEqual(await db.getActionIndexTable(5), null);
    });

    // The consensus guard: every pluralized name that names a real status-bearing table
    // resolves to that table, and no other name resolves.
    // Read from src/sql so a new action table cannot drift from the allowlist unnoticed.
    it('resolves exactly the schema tables that carry action_index and status_id', async function () {
        let checked = 0;
        for (const { table, hasStatus } of schemaTables()) {
            const action = actionForTable(table);
            if (action === null) continue;
            const db = dbWithDoQuery([{ action }]);
            assert.strictEqual(await db.getActionIndexTable(5), hasStatus ? table : null, table);
            sinon.restore();
            checked++;
        }
        assert.ok(checked > 100, 'expected to walk the whole schema directory, walked ' + checked);
    });
});

describe('Database.isActionIndexValid() on an action with no status table @regression @tier1', function () {
    it('returns false without querying a table', async function () {
        const db      = makeDb();
        const doQuery = sinon.stub(db, 'doQuery');
        doQuery.onFirstCall().resolves([{ action: 'deploy' }]);
        doQuery.onSecondCall().rejects(new Error("Table 'deploys' doesn't exist"));
        assert.strictEqual(await db.isActionIndexValid(99), false);
        assert.strictEqual(doQuery.callCount, 1);
    });
});
