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
 * Drives the contract_executions text clips against a REAL MariaDB under the indexer's
 * pinned session sql_mode. Whether an over-capacity value is refused, and whether a
 * clipped value is accepted and read back byte-for-byte, is the server's answer, which a
 * doQuery stub cannot give. So this file builds contract_executions from the product's
 * own src/sql/contract_executions.sql, pins SESSION_SQL_MODE, proves the unclipped
 * values are refused (so the test can see the failure it guards), then inserts the
 * normalizeDataValues output and reads it back.
 *
 * Self-skips when TEST_DB_PASS is unset, matching the other DB-backed files here.
 * Run it with bin/run-db-tiers.sh.
 */

'use strict';

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert  = require('assert');
const fs      = require('fs');
const path    = require('path');
const mariadb = require('mariadb');

const Database             = require('../../src/db');
const Utility              = require('../../src/utility.js');
const { SESSION_SQL_MODE } = require('../../src/db/shared.js');
const { getTestConfig }    = require('../fixtures/config');

const dbc = require('./setup/db-connection');
const { DB_HOST, DB_PORT, DB_USER, DB_PASS } = dbc;
const DB_NAME = dbc.scopedDbName(dbc.INDEXER_DB, dbc.fileKey(__filename));

const DDL_FILE = path.join(__dirname, '../../src/sql/contract_executions.sql');
const EMOJI    = '\u{1F600}';

const INSERT_SQL = `INSERT INTO contract_executions
    (action_index, contract_index, caller_id, method_name, input_params,
     gas_used, gas_limit, status_id, error_message, emitted_count, block_index)
    VALUES (?, 1, 1, ?, '', 0, 0, 1, ?, 0, 1)`;

const stripSqlLineComments = Database.prototype.stripSqlLineComments;
const splitSqlStatements   = (sql) => Database.prototype.splitSqlStatements.call(Database.prototype, sql);

function makeNormalize() {
    const obj = { config: getTestConfig(), util: new Utility(),
                  normalizeDataValues: Database.prototype.normalizeDataValues };
    return obj.normalizeDataValues.bind(obj);
}

async function setUp(ctx) {
    ctx.admin = await mariadb.createConnection({ host: DB_HOST, port: DB_PORT, user: DB_USER,
                                                 password: DB_PASS, multipleStatements: true });
    await ctx.admin.query('DROP DATABASE IF EXISTS ' + DB_NAME + '; CREATE DATABASE ' + DB_NAME + ';');
    ctx.conn = await mariadb.createConnection({ host: DB_HOST, port: DB_PORT, user: DB_USER,
                                                password: DB_PASS, database: DB_NAME,
                                                initSql: "SET sql_mode='" + SESSION_SQL_MODE + "'" });
    const ddl = fs.readFileSync(DDL_FILE, 'utf8');
    for (const stmt of splitSqlStatements(stripSqlLineComments(ddl))) await ctx.conn.query(stmt);
    const rows = await ctx.conn.query('SELECT @@SESSION.sql_mode AS m');
    assert.deepStrictEqual(String(rows[0].m).split(',').sort(), SESSION_SQL_MODE.split(',').sort());
}

async function tearDown(ctx) {
    if (ctx.conn) await ctx.conn.end();
    if (ctx.admin) {
        await ctx.admin.query('DROP DATABASE IF EXISTS ' + DB_NAME);
        await ctx.admin.end();
    }
}

async function readBack(ctx, actionIndex) {
    const rows = await ctx.conn.query(
        'SELECT method_name, error_message FROM contract_executions WHERE action_index=?', [actionIndex]);
    assert.strictEqual(rows.length, 1);
    return rows[0];
}

const CASES = [
    { name: 'a 70,008-character ASCII revert reason', error: 'revert: ' + 'r'.repeat(70000), refusals: [1406] },
    { name: 'an 80,000-byte emoji revert reason',     error: 'revert: ' + EMOJI.repeat(20000), refusals: [1366, 1406] },
    { name: 'a 300-character method name',            method: 'm'.repeat(300), refusals: [1406] },
];

describe('contract_executions text clips against MariaDB @integration', function () {
    const ctx = {};
    let normalize;

    before(async function () {
        if (process.env.TEST_DB_PASS === undefined) this.skip();
        assert.ok(DB_PASS, 'DB_PASS must be available when TEST_DB_PASS is set');
        normalize = makeNormalize();
        await setUp(ctx);
    });
    after(async function () { await tearDown(ctx); });

    CASES.forEach((c, i) => {
        it('refuses the unclipped value of ' + c.name + ' under the pinned sql_mode', async function () {
            await assert.rejects(ctx.conn.query(INSERT_SQL, [100 + i, c.method || 'run', c.error || null]),
                (e) => c.refusals.includes(e.errno));
        });

        it('stores the clipped value of ' + c.name + ' and reads it back unchanged', async function () {
            const out = normalize({ ACTION: 'EXECUTE', METHOD_NAME: c.method || 'run', ERROR_MESSAGE: c.error || null });
            await ctx.conn.query(INSERT_SQL, [200 + i, out.METHOD_NAME, out.ERROR_MESSAGE]);
            const row = await readBack(ctx, 200 + i);
            assert.strictEqual(row.method_name, out.METHOD_NAME);
            assert.strictEqual(row.error_message, out.ERROR_MESSAGE);
        });
    });
});
