/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
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
 * test/unit/db.mapping-null-skip.test.js
 *
 * REINDEX REGRESSION GUARD for createActionMapping / createFileMapping.
 *
 * After 0b023b2 a dangling or out-of-band wire ^<id> reference resolves to null
 * (createAddress/createTicker return null instead of coercing to a phantom id).
 * createActionMapping/createFileMapping then inserted that null straight into the
 * NOT-NULL mappings_actions.id / mappings_files.id column, aborting the whole
 * block with ER_BAD_NULL_ERROR; on a from-scratch reindex (which genesis
 * activation forces) the indexer retry-looped forever on the first such action.
 *
 * Fix: skip the mapping row when the resolved id is null, honoring 0b023b2's
 * "treat as a no-op rather than mint a bogus row" contract. The mappings_* tables
 * are lookup indexes (not in stateHash.js), so skipping changes no block hashes.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../fixtures/config');
const Utility           = require('../../src/utility');
const Database          = require('../../src/db');

function makeDb() {
    const config  = getTestConfig();
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

afterEach(function () { sinon.restore(); });

describe('Database mapping null-id skip guard @regression @tier1', function () {

    it('createActionMapping skips (no SELECT/INSERT) when an address ref resolves to null', async function () {
        const db = makeDb();
        sinon.stub(db, 'createAddress').resolves(null); // dangling ^<id> -> null
        const calls = [];
        sinon.stub(db, 'doQuery').callsFake(async (sql, args) => { calls.push({ sql, args }); return []; });

        await db.createActionMapping(121, 'address', '^999999');

        assert.ok(!calls.some(c => /mappings_actions/i.test(c.sql)),
            'must not touch mappings_actions when the id is null');
        assert.strictEqual(calls.length, 0, 'a null id short-circuits before any query');
    });

    it('createActionMapping skips when a tick ref resolves to null', async function () {
        const db = makeDb();
        sinon.stub(db, 'createTicker').resolves(null);
        const calls = [];
        sinon.stub(db, 'doQuery').callsFake(async (sql, args) => { calls.push({ sql, args }); return []; });

        await db.createActionMapping(121, 'tick', '^888888');

        assert.ok(!calls.some(c => /mappings_actions/i.test(c.sql)),
            'must not touch mappings_actions when the id is null');
    });

    it('createActionMapping still inserts a resolved address mapping (id non-null)', async function () {
        const db = makeDb();
        sinon.stub(db, 'createAddress').resolves(42);
        const calls = [];
        sinon.stub(db, 'doQuery').callsFake(async (sql, args) => {
            calls.push({ sql, args });
            if (/^\s*SELECT/i.test(sql)) return []; // not already present
            return [];
        });

        await db.createActionMapping(121, 'address', 'mRealAddr');

        const insert = calls.find(c => /INSERT INTO mappings_actions/i.test(c.sql));
        assert.ok(insert, 'a resolved id must still be mapped');
        assert.deepStrictEqual(insert.args, [121, 2, 42], 'type_id=2 (address) and the resolved id are bound');
    });

    it('createFileMapping skips when the tick ref resolves to null', async function () {
        const db = makeDb();
        sinon.stub(db, 'createTicker').resolves(null);
        const calls = [];
        sinon.stub(db, 'doQuery').callsFake(async (sql, args) => { calls.push({ sql, args }); return []; });

        await db.createFileMapping(121, 'tick', '^777777');

        assert.ok(!calls.some(c => /mappings_files/i.test(c.sql)),
            'must not touch mappings_files when the id is null');
        assert.strictEqual(calls.length, 0, 'a null id short-circuits before any query');
    });
});
