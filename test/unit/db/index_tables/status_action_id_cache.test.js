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
 * test/unit/db/index_tables/status_action_id_cache.test.js
 *
 * Transaction-bound cache coverage for status and action ids.
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
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', {
        config: getTestConfig(),
        util:   new Utility()
    });
    const rows = new Map();
    let nextId = 1;
    const connection = {
        beginTransaction: sinon.stub().resolves(),
        commit:           sinon.stub().resolves(),
        rollback:         sinon.stub().resolves(),
        release:          sinon.stub().resolves()
    };

    sinon.stub(db, 'getConnection').resolves(connection);
    const query = sinon.stub(db, 'doQuery').callsFake(async (sql, args) => {
        const table = /index_(statuses|actions)/.exec(sql)[1];
        const key   = table + ':' + args[0];
        if(/^\s*INSERT/i.test(sql)){
            if(!rows.has(key)) rows.set(key, nextId++);
            return {};
        }
        return rows.has(key) ? [{ id: rows.get(key) }] : [];
    });
    return { db, rows, query, connection };
}

afterEach(function () {
    sinon.restore();
});

describe('Database status/action id cache @regression @tier1', function () {
    it('serves a pending id inside the transaction that assigned it', async function () {
        const { db, query } = makeDb();
        await db.beginTransaction();
        const id = await db.createStatus('valid');
        query.resetHistory();

        assert.strictEqual(await db.getStatusId('valid'), id);
        assert.strictEqual(query.callCount, 0);
    });

    it('promotes a pending id after commit and serves it without another query', async function () {
        const { db, query } = makeDb();
        await db.beginTransaction();
        const id = await db.createAction('ORDER');
        await db.commitTransaction();
        query.resetHistory();

        assert.strictEqual(await db.getActionId('ORDER'), id);
        assert.strictEqual(query.callCount, 0);
    });

    it('drops a rolled-back id so the next lookup reads the database', async function () {
        const { db, rows, query } = makeDb();
        await db.beginTransaction();
        await db.createAction('ORDER');
        await db.rollbackTransaction();
        rows.delete('actions:ORDER');
        query.resetHistory();

        assert.strictEqual(await db.getActionId('ORDER'), null);
        assert.strictEqual(query.callCount, 1);
    });

    it('drops a pending id when commit fails', async function () {
        const { db, rows, query, connection } = makeDb();
        connection.commit.rejects(new Error('commit failed'));
        await db.beginTransaction();
        await db.createStatus('pending');
        await assert.rejects(() => db.commitTransaction(), /commitTransaction error=Error: commit failed/);
        rows.delete('statuses:pending');
        query.resetHistory();

        assert.strictEqual(await db.getStatusId('pending'), null);
        assert.strictEqual(query.callCount, 1);
    });
});
