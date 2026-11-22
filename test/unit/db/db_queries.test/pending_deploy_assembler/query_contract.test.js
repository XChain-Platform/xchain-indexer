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
 * test/unit/db/db_queries.test/pending_deploy_assembler/query_contract.test.js
 *
 * The deferred DEPLOY assembler read, exercised through the real Database
 * method with only address lookup and query execution stubbed.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { makeDb } = require('../helpers/db_stub');
const { PENDING_ASSEMBLY_STATUS } = require('../../../../../src/actions/deploy/constants.js');

afterEach(function () {
    sinon.restore();
});

describe('Database.getPendingDeployAssembler() @regression @tier1', function () {
    it('binds the shared pending status and returns the first row', async function () {
        const db  = makeDb();
        const row = { action_index: 5, code_hash: 'hash' };
        sinon.stub(db, 'getAddressId').resolves(17);
        const query = sinon.stub(db, 'doQuery').resolves([row]);

        const result = await db.getPendingDeployAssembler('source', 'hash', 10);

        assert.strictEqual(result, row);
        assert.strictEqual(query.callCount, 1);
        const [sql, params] = query.firstCall.args;
        assert.ok(sql.includes('AND s.status=?'));
        assert.ok(!sql.includes(PENDING_ASSEMBLY_STATUS));
        assert.deepStrictEqual(params, [17, 'hash', 10, PENDING_ASSEMBLY_STATUS]);
    });

    it('returns null when the query finds no pending assembler', async function () {
        const db = makeDb();
        sinon.stub(db, 'getAddressId').resolves(17);
        sinon.stub(db, 'doQuery').resolves([]);

        assert.strictEqual(await db.getPendingDeployAssembler('source', 'hash', 10), null);
    });

    it('skips the query when the source address is unknown', async function () {
        const db = makeDb();
        sinon.stub(db, 'getAddressId').resolves(null);
        const query = sinon.stub(db, 'doQuery');

        assert.strictEqual(await db.getPendingDeployAssembler('source', 'hash', 10), null);
        assert.strictEqual(query.callCount, 0);
    });
});
