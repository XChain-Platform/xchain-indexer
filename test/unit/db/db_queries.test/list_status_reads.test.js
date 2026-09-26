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

    it('returns the type of a valid LIST once reference validation is active', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([{ type: '2' }]);

        assert.strictEqual(await db.getListType(10, 0), 2);
        assert.match(db.doQuery.firstCall.args[0], /index_statuses/);
    });
});
