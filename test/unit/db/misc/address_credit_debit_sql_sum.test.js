/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/db/misc/address_credit_debit_sql_sum.test.js
 *
 * getAddressCreditDebit sums in SQL when every matching row is a canonical
 * ledger decimal, and keeps the JS fold when any row is not. The stub db
 * answers the grouped sum query and the per-row query by SQL text, so each
 * case shows which path ran and that both give the same balances.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../../../fixtures/config');
const Utility           = require('../../../../src/utility');
const Database          = require('../../../../src/db');
const { LEDGER_AMOUNT_PRECISION } = require('../../../../src/consensus/ledger_amount_precision_gate');

function makeDb() {
    const config = getTestConfig();
    config['NETWORK'] = 'regtest';
    config['COIN']    = 'BTC';
    const util = new Utility();
    sinon.stub(util, 'logError');
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config, util });
    db.pool = { getConnection: sinon.stub().resolves({
        query:   sinon.stub().resolves([]),
        release: sinon.stub().resolves()
    }) };
    return db;
}

// Per-row ledger amounts on ticks 11 and 12, as the fold reads them.
const ROWS = [
    { tick_id: 11, amount: '2',                    decimals: 8 },
    { tick_id: 11, amount: '0.000000000000000001', decimals: 8 },
    { tick_id: 12, amount: '3',                    decimals: 0 },
    { tick_id: 12, amount: '0.25',                 decimals: 0 },
];

// The grouped rows the sum query returns for ROWS, with `nonCanonical` rows flagged on tick 12.
function sumRows(nonCanonical) {
    return [
        { tick_id: 11, amount: '2.000000000000000001', non_canonical: 0 },
        { tick_id: 12, amount: '3.250000000000000000', non_canonical: nonCanonical },
    ];
}

// Answer the grouped sum query with `sums` and the per-row query with ROWS.
function stubReads(db, sums) {
    return sinon.stub(db, 'doQuery').callsFake(async (sql) => (/GROUP BY m\.tick_id/.test(sql) ? sums : ROWS));
}

// The fold getAddressCreditDebit applied before the SQL sum path, over ROWS.
function foldRows(util) {
    const data = [];
    for (const row of ROWS) {
        if (!data[row.tick_id]) data[row.tick_id] = 0;
        data[row.tick_id] = util.bcadd(data[row.tick_id], row.amount, LEDGER_AMOUNT_PRECISION);
    }
    return data;
}

function assertSameBalances(util, got, want) {
    assert.ok(Array.isArray(got));
    assert.strictEqual(got.length, want.length);
    assert.deepStrictEqual(Object.keys(got), Object.keys(want));
    for (const k of Object.keys(want)) assert.strictEqual(util.bcstr(got[k]), util.bcstr(want[k]));
}

afterEach(function () { sinon.restore(); });

describe('getAddressCreditDebit SQL sum with JS fold fallback @regression @tier1', function () {
    it('returns the SQL sum, equal to the fold, when every row is canonical', async function () {
        const db = makeDb();
        const dq = stubReads(db, sumRows(0));
        const out = await db.getAddressCreditDebit('credits', 22, null, 500, 7, null);
        sinon.assert.calledOnce(dq);
        const [sql, args] = dq.firstCall.args;
        assert.ok(sql.includes('SUM(CAST(m.amount AS DECIMAL(60,18)))'));
        assert.ok(sql.includes('non_canonical'));
        assert.ok(sql.includes('m.action_index < ?'));
        assert.ok(/GROUP BY m\.tick_id\s*$/.test(sql));
        assert.deepStrictEqual(args, [22, 7]);
        assertSameBalances(db.util, out, foldRows(db.util));
        assert.strictEqual(db.util.bcstr(out[11]), '2.000000000000000001');
        assert.strictEqual(db.util.bcstr(out[12]), '3.25');
    });

    it('keeps the JS fold when any row is non-canonical', async function () {
        const db = makeDb();
        const dq = stubReads(db, sumRows('1'));
        const out = await db.getAddressCreditDebit('debits', 22, null, 500, null, 12);
        sinon.assert.calledTwice(dq);
        const [sql, args] = dq.secondCall.args;
        assert.ok(!sql.includes('GROUP BY'));
        assert.ok(sql.includes('m.amount'));
        assert.ok(sql.includes('t1.block_index < ?'));
        assert.deepStrictEqual(args, [22, 500, 12]);
        assertSameBalances(db.util, out, foldRows(db.util));
    });

    it('returns an empty array from the sum path when no row matches', async function () {
        const db = makeDb();
        const dq = stubReads(db, []);
        const out = await db.getAddressCreditDebit('credits', 22, null, 500);
        sinon.assert.calledOnce(dq);
        assert.ok(Array.isArray(out));
        assert.strictEqual(out.length, 0);
    });
});
