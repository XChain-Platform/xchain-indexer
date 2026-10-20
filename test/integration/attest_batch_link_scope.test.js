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
 * The ATTEST v1 batch link against a REAL MariaDB. A request keeps every rejected
 * on-chain v1 under its request_id beside the one valid row the mirror applier writes,
 * and only that valid row's body rode the batch, so the link and its reorg clear must
 * touch it alone. Built from the product's own attests.sql and index_statuses.sql.
 *
 * Self-skips when TEST_DB_PASS is unset, matching the other DB-backed files here.
 * Run it with bin/run-db-tiers.sh.
 */

'use strict';

const assert  = require('assert');
const fs      = require('fs');
const path    = require('path');
const mariadb = require('mariadb');

const Database        = require('../../src/db');
const mirrorResponses = require('../../src/db/attests/mirror_responses.js');

const dbc = require('./setup/db-connection');
const { DB_HOST, DB_PORT, DB_USER, DB_PASS } = dbc;
const DB_NAME = dbc.scopedDbName(dbc.INDEXER_DB, dbc.fileKey(__filename));

const SQL_DIR    = path.join(__dirname, '../../src/sql');
const REQUEST_ID = 'ab'.repeat(32);
const REJECTED   = 'invalid: ATTEST v1 after mirror activation';

const stripSqlLineComments = Database.prototype.stripSqlLineComments;
const splitSqlStatements   = (sql) => Database.prototype.splitSqlStatements.call(Database.prototype, sql);

// The real getStatusId and setAttestationResponseBatchIndex over a plain connection.
function makeDb(conn) {
    return {
        doQuery: (sql, params) => conn.query(sql, params),
        transactionConnection: null,
        _statusActionIdCache: {
            committed: { status: new Map(), action: new Map() },
            pending:   { status: new Map(), action: new Map() },
        },
        getStatusId: Database.prototype.getStatusId,
        setAttestationResponseBatchIndex: mirrorResponses.setAttestationResponseBatchIndex,
    };
}

async function setUp(ctx) {
    ctx.admin = await mariadb.createConnection({ host: DB_HOST, port: DB_PORT, user: DB_USER,
                                                 password: DB_PASS, multipleStatements: true });
    await ctx.admin.query('DROP DATABASE IF EXISTS ' + DB_NAME + '; CREATE DATABASE ' + DB_NAME + ';');
    ctx.conn = await mariadb.createConnection({ host: DB_HOST, port: DB_PORT, user: DB_USER,
                                                password: DB_PASS, database: DB_NAME });
    for (const file of ['index_statuses.sql', 'attests.sql']) {
        const ddl = fs.readFileSync(path.join(SQL_DIR, file), 'utf8');
        for (const stmt of splitSqlStatements(stripSqlLineComments(ddl))) await ctx.conn.query(stmt);
    }
    await ctx.conn.query('INSERT INTO index_statuses (id, status) VALUES (1, ?), (2, ?)', ['valid', REJECTED]);
    // v0 request, a rejected on-chain v1, then the mirror-applied valid v1.
    await ctx.conn.query(
        `INSERT INTO attests (action_index, version, request_id, provider_id, status_id, block_index)
         VALUES (10, 0, ?, 'p', 1, 100), (11, 1, ?, 'p', 2, 101), (12, 1, ?, 'p', 1, 102)`,
        [REQUEST_ID, REQUEST_ID, REQUEST_ID]);
    ctx.db = makeDb(ctx.conn);
}

async function tearDown(ctx) {
    if (ctx.conn) await ctx.conn.end();
    if (ctx.admin) {
        await ctx.admin.query('DROP DATABASE IF EXISTS ' + DB_NAME);
        await ctx.admin.end();
    }
}

async function links(ctx) {
    const rows = await ctx.conn.query(
        'SELECT action_index, batch_action_index FROM attests WHERE request_id = ? ORDER BY action_index', [REQUEST_ID]);
    return rows.map((r) => [Number(r.action_index), r.batch_action_index === null ? null : Number(r.batch_action_index)]);
}

describe('ATTEST v1 batch link scope against MariaDB @integration', function () {
    const ctx = {};

    before(async function () {
        if (process.env.TEST_DB_PASS === undefined) this.skip();
        assert.ok(DB_PASS, 'DB_PASS must be available when TEST_DB_PASS is set');
        await setUp(ctx);
    });
    after(async function () { await tearDown(ctx); });

    it('stamps the batch link on the valid v1 row only, never on a rejected v1 or the v0 request', async function () {
        await ctx.db.setAttestationResponseBatchIndex(REQUEST_ID.toUpperCase(), 777);
        assert.deepStrictEqual(await links(ctx), [[10, null], [11, null], [12, 777]]);
    });

    it('clears the link on the same valid row when a reorg passes NULL', async function () {
        await ctx.conn.query('UPDATE attests SET batch_action_index = 555 WHERE action_index = 11');
        await ctx.db.setAttestationResponseBatchIndex(REQUEST_ID, null);
        assert.deepStrictEqual(await links(ctx), [[10, null], [11, 555], [12, null]]);
    });
});
