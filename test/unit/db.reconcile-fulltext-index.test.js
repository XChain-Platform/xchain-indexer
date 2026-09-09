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
 * The boot-time index reconciler (parseExpectedIndexes + reconcileTableIndexes)
 * parsed only `CREATE [UNIQUE] INDEX`, so the FULLTEXT `meta_search` index on
 * contracts (the search index behind the explorer's contract search) was
 * invisible to it: an aged database that lost or never got the index could not
 * self-heal it, and the dated migration was the only creation path. These pin
 * the widened parser, the FULLTEXT-aware match against information_schema and
 * the heal statement, which must say FULLTEXT and carry no prefix or direction
 * (MariaDB refuses both on a FULLTEXT index).
 ********************************************************************/
'use strict';

const assert = require('assert');
const sinon  = require('sinon');
const fs     = require('fs');
const path   = require('path');
const { getTestConfig } = require('../fixtures/config');
const Utility           = require('../../src/utility');
const Database          = require('../../src/db');

function makeDb() {
    const config  = getTestConfig();
    const util    = new Utility();
    sinon.stub(util, 'logError');
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config, util });
    db.pool = { getConnection: sinon.stub().resolves({ query: sinon.stub().resolves([]), release: () => {} }) };
    return db;
}

// A fake connection: statistics rows for the live table, and every ALTER recorded.
function fakeConn(statisticsRows) {
    const alters = [];
    return {
        alters,
        query: async (sql) => {
            if (/information_schema\.statistics/i.test(sql)) return statisticsRows;
            if (/^ALTER TABLE/i.test(sql)) { alters.push(sql); return []; }
            return [];
        },
    };
}

const CONTRACTS_SQL = fs.readFileSync(path.join(__dirname, '../../src/sql/contracts.sql'), 'utf8');

describe('index reconciler admits FULLTEXT indexes @regression', function () {
    let db;
    beforeEach(() => { db = makeDb(); sinon.stub(console, 'log'); sinon.stub(console, 'warn'); });
    afterEach(() => sinon.restore());

    it('parseExpectedIndexes reads the FULLTEXT meta_search index off contracts.sql', function () {
        const idx = db.parseExpectedIndexes(CONTRACTS_SQL, 'contracts');
        const meta = idx.find((i) => i.name === 'meta_search');
        assert.ok(meta, 'meta_search is parsed at all');
        assert.deepStrictEqual(meta.columns, ['meta_name', 'meta_description']);
        assert.strictEqual(meta.fulltext, true);
        assert.strictEqual(meta.unique, false);
        // UNIQUE stays UNIQUE, a plain index stays neither.
        for (const i of idx) assert.ok(!(i.unique && i.fulltext), i.name + ' cannot be both');
    });

    it('heals a missing meta_search with ADD FULLTEXT INDEX and bare column names', async function () {
        // Every declared index of contracts is live EXCEPT meta_search.
        const declared = db.parseExpectedIndexes(CONTRACTS_SQL, 'contracts').filter((i) => i.name !== 'meta_search');
        const rows = [];
        for (const i of declared) {
            i.columns.forEach((c, n) => rows.push({ INDEX_NAME: i.name, NON_UNIQUE: i.unique ? 0 : 1, INDEX_TYPE: 'BTREE', COLUMN_NAME: c, SEQ_IN_INDEX: n + 1, SUB_PART: null }));
        }
        const conn = fakeConn(rows);
        await db.reconcileTableIndexes('contracts.sql', conn);
        const heal = conn.alters.filter((s) => /`meta_search`/.test(s));
        assert.strictEqual(heal.length, 1, 'exactly one heal for meta_search: ' + JSON.stringify(conn.alters));
        assert.strictEqual(heal[0], 'ALTER TABLE `contracts` ADD FULLTEXT INDEX `meta_search` (`meta_name`, `meta_description`)');
    });

    it('a live FULLTEXT meta_search satisfies the declaration (no heal, no warning)', async function () {
        const declared = db.parseExpectedIndexes(CONTRACTS_SQL, 'contracts');
        const rows = [];
        for (const i of declared) {
            i.columns.forEach((c, n) => rows.push({ INDEX_NAME: i.name, NON_UNIQUE: i.unique ? 0 : 1, INDEX_TYPE: i.fulltext ? 'FULLTEXT' : 'BTREE', COLUMN_NAME: c, SEQ_IN_INDEX: n + 1, SUB_PART: null }));
        }
        const conn = fakeConn(rows);
        await db.reconcileTableIndexes('contracts.sql', conn);
        assert.deepStrictEqual(conn.alters, []);
        assert.strictEqual(console.warn.callCount, 0, 'no drift warning');
    });

    it('a plain BTREE index on the same columns does NOT satisfy a declared FULLTEXT index', async function () {
        const declared = db.parseExpectedIndexes(CONTRACTS_SQL, 'contracts');
        const rows = [];
        for (const i of declared) {
            // meta_search exists live but as a plain index under ANOTHER name.
            const name = i.fulltext ? 'meta_search_btree' : i.name;
            i.columns.forEach((c, n) => rows.push({ INDEX_NAME: name, NON_UNIQUE: i.unique ? 0 : 1, INDEX_TYPE: 'BTREE', COLUMN_NAME: c, SEQ_IN_INDEX: n + 1, SUB_PART: null }));
        }
        const conn = fakeConn(rows);
        await db.reconcileTableIndexes('contracts.sql', conn);
        assert.strictEqual(conn.alters.filter((s) => /ADD FULLTEXT INDEX `meta_search`/.test(s)).length, 1);
    });
});
