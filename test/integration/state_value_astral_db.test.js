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
 * Drives STATE_VALUE_ASTRAL_ESCAPE against a REAL MariaDB under the indexer's pinned
 * session sql_mode. Whether the utf8mb3 contract_state.state_value column refuses a raw
 * 4-byte character, and whether the escaped text is accepted and read back byte-for-byte,
 * is the server's answer, which a doQuery stub cannot give. So this file builds
 * contract_state from the product's own src/sql/contract_state.sql, pins
 * SESSION_SQL_MODE, proves the below-gate text is refused (the halt the gate removes),
 * then writes the at-gate text through createContractState and reads it back through
 * getContractState.
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
const contractDb           = require('../../src/db/contracts');
const { SESSION_SQL_MODE } = require('../../src/db/shared.js');
const { STATE_VALUE_ASTRAL_ESCAPE, stateValueTexts } = require('../../src/actions/execute/state_value_text.js');

const dbc = require('./setup/db-connection');
const { DB_HOST, DB_PORT, DB_USER, DB_PASS } = dbc;
const DB_NAME = dbc.scopedDbName(dbc.INDEXER_DB, dbc.fileKey(__filename));

const DDL_FILE = path.join(__dirname, '../../src/sql/contract_state.sql');
const EMOJI    = '\u{1F600}';
const VALUE    = { face: EMOJI, list: [EMOJI, 'plain'] };

const stripSqlLineComments = Database.prototype.stripSqlLineComments;
const splitSqlStatements   = (sql) => Database.prototype.splitSqlStatements.call(Database.prototype, sql);

// The texts the writers store for VALUE with the gate off and on.
function textAt(active){
    const protocolChanges = { isEnabled: async (name) => (name === STATE_VALUE_ASTRAL_ESCAPE ? active : true) };
    return stateValueTexts(() => protocolChanges, 1, [{ key: 'k', value: VALUE }]).then((texts) => texts[0]);
}

describe('contract_state.state_value astral escape against MariaDB @integration', function () {
    const ctx = {};
    let store;

    before(async function () {
        if (process.env.TEST_DB_PASS === undefined) this.skip();
        assert.ok(DB_PASS, 'DB_PASS must be available when TEST_DB_PASS is set');
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
        const cols = await ctx.conn.query("SELECT CHARACTER_SET_NAME AS c FROM information_schema.columns " +
            "WHERE table_schema = ? AND table_name = 'contract_state' AND column_name = 'state_value'", [DB_NAME]);
        assert.strictEqual(String(cols[0].c).toLowerCase().startsWith('utf8mb4'), false, 'the table must be the utf8mb3 one');
        // The product's own reader and writer, over this connection.
        store = Object.assign({ doQuery: (sql, args) => ctx.conn.query(sql, args) }, contractDb);
    });

    after(async function () {
        if (ctx.conn) await ctx.conn.end();
        if (ctx.admin) {
            await ctx.admin.query('DROP DATABASE IF EXISTS ' + DB_NAME);
            await ctx.admin.end();
        }
    });

    it('refuses the below-gate raw emoji JSON under the pinned sql_mode (the halt)', async function () {
        const raw = await textAt(false);
        assert.ok(raw.includes(EMOJI));
        await assert.rejects(store.createContractState({ CONTRACT_INDEX: 1, STATE_KEY: 'k', STATE_VALUE: raw,
                                                         BLOCK_INDEX: 1, ACTION_INDEX: 1 }),
            (e) => e.errno === 1366);
        const rows = await ctx.conn.query('SELECT COUNT(*) AS n FROM contract_state');
        assert.strictEqual(Number(rows[0].n), 0, 'a refused INSERT stores no row');
    });

    it('stores the at-gate escaped text, reads it back byte-for-byte, and reloads the same value', async function () {
        const escaped = await textAt(true);
        await store.createContractState({ CONTRACT_INDEX: 2, STATE_KEY: 'k', STATE_VALUE: escaped,
                                          BLOCK_INDEX: 2, ACTION_INDEX: 2 });
        const rows = await ctx.conn.query('SELECT state_value FROM contract_state WHERE contract_index = 2');
        assert.strictEqual(rows[0].state_value, escaped);
        const state = await store.getContractState(2);
        assert.deepStrictEqual(state.k, VALUE);
    });
});
