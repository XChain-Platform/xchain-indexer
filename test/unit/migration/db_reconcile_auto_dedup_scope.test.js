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
 * The boot-time index reconciler may DELETE duplicate rows to force a UNIQUE index, and its
 * highest-id-survivor argument holds for one key only: balances.addr_tick on
 * (address_id, tick_id). These pin that the dedupe runs for that exact declaration and for
 * nothing else on the table, and that the allow-list still names a live declaration.
 ********************************************************************/
'use strict';

const assert = require('assert');
const sinon  = require('sinon');
const fs     = require('fs');
const path   = require('path');
const { getTestConfig } = require('../../fixtures/config');
const Utility           = require('../../../src/utility');
const Database          = require('../../../src/db');
const { AUTO_DEDUP_TABLES, isAutoDedupAllowed } = require('../../../src/db/shared.js');

const BALANCES_SQL = fs.readFileSync(path.join(__dirname, '../../../src/sql/balances.sql'), 'utf8');

function makeDb() {
    const config  = getTestConfig();
    const util    = new Utility();
    sinon.stub(util, 'logError');
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config, util });
    db.pool = { getConnection: sinon.stub().resolves({ query: sinon.stub().resolves([]), release: () => {} }) };
    return db;
}

// Live balances with only PRIMARY(id) and tick_id; the first ADD UNIQUE fails on duplicates.
function fakeConn() {
    const deletes = [], alters = [];
    let refused = false;
    const live = [
        { INDEX_NAME: 'PRIMARY', NON_UNIQUE: 0, INDEX_TYPE: 'BTREE', COLUMN_NAME: 'id', SEQ_IN_INDEX: 1, SUB_PART: null },
        { INDEX_NAME: 'tick_id', NON_UNIQUE: 1, INDEX_TYPE: 'BTREE', COLUMN_NAME: 'tick_id', SEQ_IN_INDEX: 1, SUB_PART: null },
    ];
    return {
        deletes, alters,
        query: async (sql) => {
            if (/information_schema\.statistics/i.test(sql)) return live;
            if (/information_schema\.columns/i.test(sql)) return [{ COLUMN_NAME: 'id' }];
            if (/^DELETE/i.test(sql)) { deletes.push(sql); return { affectedRows: 2 }; }
            if (/^ALTER TABLE/i.test(sql)) {
                alters.push(sql);
                if (/ADD UNIQUE/i.test(sql) && !refused) {
                    refused = true;
                    throw Object.assign(new Error('Duplicate entry'), { errno: 1062 });
                }
            }
            return [];
        },
    };
}

// Reconcile balances.sql as `text` instead of the file on disk.
async function reconcileWith(db, text) {
    const real = fs.readFileSync;
    sinon.stub(fs, 'readFileSync').callsFake((p, ...rest) =>
        (String(p).endsWith('/balances.sql') ? text : real.call(fs, p, ...rest)));
    const conn = fakeConn();
    try { await db.reconcileTableIndexes('balances.sql', conn); }
    finally { fs.readFileSync.restore(); }
    return conn;
}

describe('index reconciler auto-dedup is scoped to the vetted index @regression @tier1', function () {
    let db;
    beforeEach(() => { db = makeDb(); sinon.stub(console, 'log'); sinon.stub(console, 'warn'); });
    afterEach(() => sinon.restore());

    it('dedupes the declared addr_tick on (address_id, tick_id) and retries the ADD', async function () {
        const conn = await reconcileWith(db, BALANCES_SQL);
        assert.strictEqual(conn.deletes.length, 1, JSON.stringify(conn.deletes));
        assert.match(conn.deletes[0], /t1\.`address_id` = t2\.`address_id` AND t1\.`tick_id` = t2\.`tick_id` AND t1\.id < t2\.id/);
        assert.strictEqual(conn.alters.filter((s) => /ADD UNIQUE INDEX `addr_tick`/.test(s)).length, 2);
    });

    it('deletes nothing for a different UNIQUE declared on balances', async function () {
        const conn = await reconcileWith(db, BALANCES_SQL.replace(/CREATE UNIQUE INDEX addr_tick[^;]*;/,
            'CREATE UNIQUE INDEX addr_only ON balances (address_id);'));
        assert.deepStrictEqual(conn.deletes, []);
        assert.ok(console.warn.args.some((a) => /addr_only.*no rows deleted/.test(String(a[0]))), 'a skip warning names the index');
    });

    it('deletes nothing when addr_tick is declared on other columns', async function () {
        const conn = await reconcileWith(db, BALANCES_SQL.replace('ON balances (address_id, tick_id)', 'ON balances (address_id, amount)'));
        assert.deepStrictEqual(conn.deletes, []);
    });

    it('refuses a direct dedupe call the allow-list does not name', async function () {
        const conn = fakeConn();
        assert.strictEqual(await db.dedupeForUniqueIndex(conn, 'balances', ['address_id'], 'addr_only'), false);
        assert.strictEqual(await db.dedupeForUniqueIndex(conn, 'balances', ['address_id', 'tick_id']), false);
        assert.deepStrictEqual(conn.deletes, []);
    });

    it('every allow-list entry matches a UNIQUE declaration in its table source', function () {
        assert.deepStrictEqual(Object.keys(AUTO_DEDUP_TABLES), ['balances'], 'the pin iterates a non-empty allow-list');
        for (const [table, byIndex] of Object.entries(AUTO_DEDUP_TABLES)) {
            const declared = db.parseExpectedIndexes(fs.readFileSync(path.join(__dirname, '../../../src/sql', table + '.sql'), 'utf8'), table);
            for (const [name, cols] of Object.entries(byIndex)) {
                const idx = declared.find((i) => i.unique && i.name === name);
                assert.ok(idx, table + '.' + name + ' is declared UNIQUE');
                assert.ok(isAutoDedupAllowed(table, idx.name, idx.columns, idx.prefixes), table + '.' + name + ' matches ' + cols.join(','));
            }
        }
    });
});
