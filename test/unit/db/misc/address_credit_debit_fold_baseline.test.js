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
 * test/unit/db/misc/address_credit_debit_fold_baseline.test.js
 *
 * Baseline for the getAddressCreditDebit read: the query it issues, the
 * arguments it binds and the JS fold it applies to the rows. A SQL sum path
 * may replace the fold, but it must keep every behaviour pinned here. SQL is
 * checked by substring, never by its tail, since a sum path appends its own
 * trailing clauses.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../../../fixtures/config');
const Utility           = require('../../../../src/utility');
const Database          = require('../../../../src/db');

function makeDb() {
    const config = getTestConfig();
    config['NETWORK'] = 'regtest';
    config['COIN']    = 'BTC';
    const util    = new Utility();
    sinon.stub(util, 'logError');
    const indexer = { config, util };
    const db      = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', indexer);
    db.pool = { getConnection: sinon.stub().resolves({
        query:   sinon.stub().resolves([]),
        release: sinon.stub().resolves()
    }) };
    return db;
}

// Stub doQuery to answer `rows` and expose the first call's SQL and args.
function stubRead(db, rows) {
    const dq = sinon.stub(db, 'doQuery').callsFake(async () => rows || []);
    return () => ({ sql: dq.firstCall.args[0], args: dq.firstCall.args[1] });
}

afterEach(function () { sinon.restore(); });

describe('getAddressCreditDebit read baseline: query and binds @regression @tier1', function () {

    it('action_index wins over block_index and binds [address, action_index, tick_id]', async function () {
        const db = makeDb();
        const first = stubRead(db, []);
        await db.getAddressCreditDebit('debits', 22, null, 500, 7, 11);
        const { sql, args } = first();
        assert.deepStrictEqual(args, [22, 7, 11]);
        assert.ok(sql.includes('m.action_index < ?'));
        assert.ok(sql.includes('m.tick_id=?'));
        assert.ok(!sql.includes('t1.block_index'));
        assert.ok(/FROM\s+debits\s+m/.test(sql));
    });

    it('block_index is used when no action_index is given and binds [address, block_index]', async function () {
        const db = makeDb();
        const first = stubRead(db, []);
        await db.getAddressCreditDebit('credits', 22, null, 500);
        const { sql, args } = first();
        assert.deepStrictEqual(args, [22, 500]);
        assert.ok(sql.includes('t1.block_index < ?'));
        assert.ok(!sql.includes('m.action_index < ?'));
        assert.ok(!sql.includes('m.tick_id=?'));
        assert.ok(/FROM\s+credits\s+m/.test(sql));
    });

    it('an action filter binds the id createAction resolves', async function () {
        const db = makeDb();
        sinon.stub(db, 'createAction').resolves(4);
        const first = stubRead(db, []);
        await db.getAddressCreditDebit('credits', 22, 'SEND');
        const { sql, args } = first();
        assert.deepStrictEqual(args, [22, 4]);
        assert.ok(sql.includes('a1.action_id=?'));
        assert.ok(db.createAction.calledOnceWithExactly('SEND'));
    });

    it('a ticker name as tick_id adds no tick filter', async function () {
        const db = makeDb();
        const first = stubRead(db, []);
        await db.getAddressCreditDebit('credits', 22, null, 500, null, 'XCHAIN');
        const { sql, args } = first();
        assert.deepStrictEqual(args, [22, 500]);
        assert.ok(!sql.includes('m.tick_id=?'));
    });

    it('a numeric string tick_id binds the number', async function () {
        const db = makeDb();
        const first = stubRead(db, []);
        await db.getAddressCreditDebit('credits', 22, null, null, null, '12');
        const { sql, args } = first();
        assert.deepStrictEqual(args, [22, 12]);
        assert.strictEqual(typeof args[1], 'number');
        assert.ok(sql.includes('m.tick_id=?'));
    });

    it('a string address is bound as the id createAddress resolves', async function () {
        const db = makeDb();
        sinon.stub(db, 'createAddress').resolves(77);
        const first = stubRead(db, []);
        await db.getAddressCreditDebit('debits', 'bcrt1qexample');
        assert.ok(db.createAddress.calledOnceWithExactly('bcrt1qexample'));
        assert.deepStrictEqual(first().args, [77]);
    });

    it('the escrows table issues no query and returns an empty array', async function () {
        const db = makeDb();
        const dq = sinon.stub(db, 'doQuery').resolves([]);
        const out = await db.getAddressCreditDebit('escrows', 22, null, 500);
        assert.strictEqual(dq.callCount, 0);
        assert.ok(Array.isArray(out));
        assert.strictEqual(out.length, 0);
    });
});

describe('getAddressCreditDebit read baseline: JS fold over non_canonical rows @money @regression @tier1', function () {

    it('sums per tick at the exact scale and keys the array by tick_id', async function () {
        const db = makeDb();
        stubRead(db, [
            { tick_id: 11, amount: '2',                    decimals: 0, non_canonical: 1 },
            { tick_id: 11, amount: '0.000000000000000001', decimals: 0, non_canonical: 1 },
            { tick_id: 12, amount: '3',                    decimals: 2, non_canonical: 1 },
            { tick_id: 12, amount: '0.25',                 decimals: 2, non_canonical: 1 }
        ]);
        const out = await db.getAddressCreditDebit('credits', 22);
        assert.ok(Array.isArray(out));
        assert.strictEqual(out.length, 13);
        assert.deepStrictEqual(Object.keys(out), ['11', '12']);
        assert.strictEqual(db.util.bcstr(out[11]), '2.000000000000000001');
        assert.strictEqual(db.util.bcstr(out[12]), '3.25');
    });

    it('no rows return an empty array', async function () {
        const db = makeDb();
        stubRead(db, []);
        const out = await db.getAddressCreditDebit('debits', 22);
        assert.ok(Array.isArray(out));
        assert.strictEqual(out.length, 0);
    });
});
