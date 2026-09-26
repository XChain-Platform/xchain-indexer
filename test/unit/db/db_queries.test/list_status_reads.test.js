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
 **********************************************************************/

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { makeDb } = require('./helpers/db_stub');

afterEach(function () {
    sinon.restore();
});

describe('Database.getListType() gated status reads @regression @tier1', function () {
    it('keeps the legacy type-only lookup below activation', async function () {
        const db = makeDb();
        db.config = Object.assign({}, db.config, { NETWORK: 'mainnet' });
        sinon.stub(db, 'doQuery').resolves([{ type: '2' }]);

        assert.strictEqual(await db.getListType(10, 100), 2);
        assert.doesNotMatch(db.doQuery.firstCall.args[0], /index_statuses/);
    });

    it('rejects a LIST whose status is invalid once reference validation is active', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').callsFake(async (query) =>
            /index_statuses/.test(query) ? [] : [{ type: '2' }]);

        assert.strictEqual(await db.getListType(10, 0), false);
        assert.match(db.doQuery.firstCall.args[0], /s\.status='valid'/);
    });

    for(const action_index of [null, 'not-numeric']){
        it('does not query a malformed reference ' + String(action_index), async function () {
            const db = makeDb();
            sinon.stub(db, 'doQuery').resolves([{ type: '2' }]);

            assert.deepStrictEqual(await db.getList(action_index, 0), []);
            sinon.assert.notCalled(db.doQuery);
        });
    }

    it('returns the type of a valid LIST once reference validation is active', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([{ type: '2' }]);

        assert.strictEqual(await db.getListType(10, 0), 2);
        assert.match(db.doQuery.firstCall.args[0], /index_statuses/);
    });
});

describe('Database.getList() gated invalid references @regression @tier1', function () {
    it('keeps invalid LIST membership readable below activation', async function () {
        const db = makeDb();
        db.config = Object.assign({}, db.config, { NETWORK: 'mainnet' });
        sinon.stub(db, 'doQuery').callsFake(async (query) =>
            /FROM\s+list_items/.test(query) ? [{ item: 'legacy-member' }] : [{ type: '2' }]);

        assert.deepStrictEqual(await db.getList(10, 100), ['legacy-member']);
    });

    for(const field of ['ALLOW_LIST', 'BLOCK_LIST']){
        it('treats an invalid-referenced ' + field + ' as absent', async function () {
            const db = makeDb();
            sinon.stub(db, 'doQuery').callsFake(async (query) => {
                if(/index_statuses/.test(query))
                    return [];
                if(/SELECT type FROM lists/.test(query))
                    return [{ type: '2' }];
                return [{ item: 'blocked-address' }];
            });
            sinon.stub(db, 'getTokenInfo').resolves({ [field]: 10 });
            sinon.stub(db, 'isTickSleeping').resolves(false);
            sinon.stub(db, 'isAddressSleeping').resolves(false);

            const listRead = sinon.spy(db, 'getList');
            assert.strictEqual(await db.isActionAllowed('blocked-address', 'TEST', 0), true);
            assert.strictEqual(await listRead.firstCall.returnValue, null,
                'the policy check must receive no list from the real reader');
        });
    }

    it('keeps a valid empty allow list attached', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').callsFake(async (query) =>
            /index_statuses/.test(query) ? [{ type: '2' }] : []);
        sinon.stub(db, 'getTokenInfo').resolves({ ALLOW_LIST: 10 });
        sinon.stub(db, 'isTickSleeping').resolves(false);
        sinon.stub(db, 'isAddressSleeping').resolves(false);

        assert.deepStrictEqual(await db.getList(10, 0), []);
        assert.strictEqual(await db.isActionAllowed('unlisted-address', 'TEST', 0), false);
    });
});
