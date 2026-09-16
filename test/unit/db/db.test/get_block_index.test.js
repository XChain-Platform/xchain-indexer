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

// test/unit/db/db.test/get_block_index.test.js
//
// Covers getBlockIndex input validation and accepted extent queries.

'use strict';

const { assert, sinon, getTestConfig, Utility, Database } = require('./helpers/db.js');

// ---------------------------------------------------------------------------
// describe: getBlockIndex (input validation only, mocked doQuery)
// ---------------------------------------------------------------------------
let db;

function setupDb() {
    const config = getTestConfig();
    const util   = new Utility();

    // Stub logError so it does not print to console during tests
    sinon.stub(util, 'logError');

    db = {
        config,
        util,
        doQuery: sinon.stub().resolves([]),
        // createReorg writes its marker via doQueryStrict (throw-on-fault) so a swallowed
        // INSERT failure can't leave the processed-reorg cursor un-advanced.
        doQueryStrict: sinon.stub().resolves([]),
        getBlockIndex: Database.prototype.getBlockIndex,
    };
}

describe('Database.getBlockIndex() input validation @regression @tier1', function () {
    beforeEach(setupDb);
    afterEach(function () {
        sinon.restore();
    });

    it('returns null for an invalid component', async function () {
        const result = await db.getBlockIndex.call(db, 'invalid', 'first');
        assert.strictEqual(result, null);
    });

    it('returns null for an invalid type', async function () {
        const result = await db.getBlockIndex.call(db, 'indexer', 'unknown');
        assert.strictEqual(result, null);
    });

    it("treats the removed legacy 'reorg' type as invalid (live path uses getReorgsSince)", async function () {
        // getBlockIndex(...,'reorg') was a dead single-newest-row reader; it now falls
        // into the invalid-type path and must never query.
        const result = await db.getBlockIndex.call(db, 'decoder', 'reorg');
        assert.strictEqual(result, null);
        assert.strictEqual(db.doQuery.callCount, 0);
    });

    it('does not call doQuery when component is invalid', async function () {
        await db.getBlockIndex.call(db, 'bad', 'first');
        assert.strictEqual(db.doQuery.callCount, 0);
    });

    it('does not call doQuery when type is invalid', async function () {
        await db.getBlockIndex.call(db, 'decoder', 'bad');
        assert.strictEqual(db.doQuery.callCount, 0);
    });

});

describe('Database.getBlockIndex() input validation @regression @tier1', function () {
    beforeEach(setupDb);
    afterEach(function () {
        sinon.restore();
    });

    it('calls doQuery when component=decoder and type=first', async function () {
        db.doQuery.resolves([{ block_index: 1 }]);
        const result = await db.getBlockIndex.call(db, 'decoder', 'first');
        assert.strictEqual(db.doQuery.callCount, 1);
        assert.strictEqual(result, 1);
    });

    it('calls doQuery when component=indexer and type=last', async function () {
        db.doQuery.resolves([{ block_index: 500 }]);
        const result = await db.getBlockIndex.call(db, 'indexer', 'last');
        assert.strictEqual(db.doQuery.callCount, 1);
        assert.strictEqual(result, 500);
    });

    it('returns null when doQuery returns empty array for first/last', async function () {
        db.doQuery.resolves([]);
        const result = await db.getBlockIndex.call(db, 'decoder', 'last');
        assert.strictEqual(result, null);
    });

    it('returns null when block_index column is null for first/last', async function () {
        db.doQuery.resolves([{ block_index: null }]);
        const result = await db.getBlockIndex.call(db, 'indexer', 'first');
        assert.strictEqual(result, null);
    });

    it('accepts the valid block-extent types without returning null early', async function () {
        for (const type of ['first', 'last']) {
            db.doQuery.reset();
            db.doQuery.resolves([]);
            const result = await db.getBlockIndex.call(db, 'decoder', type);
            // Should reach doQuery (not return null from validation)
            assert.strictEqual(db.doQuery.callCount, 1, `type=${type} should call doQuery`);
        }
    });

    it('accepts both valid component values without returning null early', async function () {
        for (const component of ['decoder', 'indexer']) {
            db.doQuery.reset();
            db.doQuery.resolves([]);
            const result = await db.getBlockIndex.call(db, component, 'first');
            assert.strictEqual(db.doQuery.callCount, 1, `component=${component} should call doQuery`);
        }
    });
});
