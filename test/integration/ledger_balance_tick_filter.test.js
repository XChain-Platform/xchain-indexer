/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC, https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available; contact
 * legal@dankest.llc.
 *
 **********************************************************************
 * test/integration/ledger_balance_tick_filter.test.js
 *
 * Drives getAddressBalances against a REAL MariaDB built from the product's own
 * ledger DDL. The controller-guard gas reads pass the GAS tick_id, and every
 * consumer reads only that key, so the filtered map must carry exactly the GAS
 * entry with the same value the unfiltered map holds for it. A ticker name must
 * never reach the SQL as a filter, so it keeps the full map.
 *
 * Self-skips when TEST_DB_PASS is unset, matching the other DB-backed files here.
 */

'use strict';

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert  = require('assert');
const fs      = require('fs');
const path    = require('path');
const mariadb = require('mariadb');

const Database          = require('../../src/db');
const Utility           = require('../../src/utility.js');
const { getTestConfig } = require('../fixtures/config');

const dbc = require('./setup/db-connection');
const { DB_HOST, DB_PORT, DB_USER, DB_PASS } = dbc;
const DB_NAME = dbc.scopedDbName(dbc.INDEXER_DB, dbc.fileKey(__filename));

const DDL_TABLES = ['credits', 'debits', 'actions', 'transactions', 'tokens', 'index_actions'];
const SOURCE  = 42;
const OTHER   = 43;
const GAS_ID  = 7;
const TOKEN_ID = 9;

const splitSqlStatements   = (sql) => Database.prototype.splitSqlStatements.call(Database.prototype, sql);
const stripSqlLineComments = Database.prototype.stripSqlLineComments;

// Seed two tokens for SOURCE, one GAS credit for another address, and one GAS credit past the bound
async function seed(conn) {
    await conn.query("INSERT INTO index_actions (id, action) VALUES (1, 'SEND')");
    await conn.query('INSERT INTO tokens (tick_id, decimals) VALUES (?, 8), (?, 0)', [GAS_ID, TOKEN_ID]);
    for (let i = 1; i <= 8; i++) {
        await conn.query('INSERT INTO transactions (tx_index, block_index, tx_hash_id) VALUES (?, ?, ?)', [i, 100 + i, i]);
        await conn.query('INSERT INTO actions (action_index, block_index, tx_index, action_id) VALUES (?, ?, ?, 1)', [i, 100 + i, i]);
    }
    const credits = [[1, SOURCE, GAS_ID, '5'], [2, SOURCE, GAS_ID, '0.25'], [3, SOURCE, TOKEN_ID, '100'],
                     [4, OTHER, GAS_ID, '99'], [8, SOURCE, GAS_ID, '1000']];
    for (const row of credits)
        await conn.query('INSERT INTO credits (action_index, address_id, tick_id, amount) VALUES (?, ?, ?, ?)', row);
    const debits = [[5, SOURCE, GAS_ID, '1.5'], [6, SOURCE, TOKEN_ID, '40']];
    for (const row of debits)
        await conn.query('INSERT INTO debits (action_index, address_id, tick_id, amount) VALUES (?, ?, ?, ?)', row);
}

// Render a balances map as plain strings so maps compare by value
function plain(util, balances) {
    const out = {};
    for (const key of Object.keys(balances)) out[key] = util.bcstr(balances[key]);
    return out;
}

describe('getAddressBalances tick_id filter against MariaDB @integration', function () {
    const ctx = {};

    before(async function () {
        if (process.env.TEST_DB_PASS === undefined) this.skip();
        ctx.admin = await mariadb.createConnection({ host: DB_HOST, port: DB_PORT, user: DB_USER,
                                                     password: DB_PASS, multipleStatements: true });
        await ctx.admin.query('DROP DATABASE IF EXISTS ' + DB_NAME + '; CREATE DATABASE ' + DB_NAME + ';');
        ctx.conn = await mariadb.createConnection({ host: DB_HOST, port: DB_PORT, user: DB_USER,
                                                    password: DB_PASS, database: DB_NAME });
        for (const table of DDL_TABLES) {
            const ddl = fs.readFileSync(path.join(__dirname, '../../src/sql/' + table + '.sql'), 'utf8');
            for (const stmt of splitSqlStatements(stripSqlLineComments(ddl))) await ctx.conn.query(stmt);
        }
        await seed(ctx.conn);
        ctx.util = new Utility();
        ctx.db = new Database(DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASS, { config: getTestConfig(), util: ctx.util });
    });

    after(async function () {
        if (ctx.db) await ctx.db.pool.end();
        if (ctx.conn) await ctx.conn.end();
        if (ctx.admin) {
            await ctx.admin.query('DROP DATABASE IF EXISTS ' + DB_NAME);
            await ctx.admin.end();
        }
    });

    it('returns every token below the bound when no tick_id is given', async function () {
        const full = plain(ctx.util, await ctx.db.getAddressBalances(SOURCE, null, null, 8));
        assert.deepStrictEqual(full, { [GAS_ID]: '3.75', [TOKEN_ID]: '60' });
    });

    it('returns only the GAS entry, valued as in the full map, for a numeric or digit-string tick_id', async function () {
        const full = plain(ctx.util, await ctx.db.getAddressBalances(SOURCE, null, null, 8));
        for (const tickId of [GAS_ID, String(GAS_ID)]) {
            const gas = plain(ctx.util, await ctx.db.getAddressBalances(SOURCE, tickId, null, 8));
            assert.deepStrictEqual(gas, { [GAS_ID]: full[GAS_ID] });
        }
    });

    it('keeps the full map when given a ticker name instead of a tick_id', async function () {
        const full  = plain(ctx.util, await ctx.db.getAddressBalances(SOURCE, null, null, 8));
        const named = plain(ctx.util, await ctx.db.getAddressBalances(SOURCE, 'XCHAIN', null, 8));
        assert.deepStrictEqual(named, full);
    });

    it('omits the GAS entry when filtered to another token, and still honours the action bound', async function () {
        const other = plain(ctx.util, await ctx.db.getAddressBalances(SOURCE, TOKEN_ID, null, 8));
        assert.deepStrictEqual(other, { [TOKEN_ID]: '60' });
        const late = plain(ctx.util, await ctx.db.getAddressBalances(SOURCE, GAS_ID, null, 9));
        assert.deepStrictEqual(late, { [GAS_ID]: '1003.75' });
    });
});
