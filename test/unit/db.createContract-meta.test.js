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
 * test/unit/db.createContract-meta.test.js
 *
 * createContract() is the single write site for the contract meta manifest
 * (CONTRACT_META_REQUIRED): deploy.js hands it META_NAME / META_DESCRIPTION /
 * META_VERSION / META_JSON only for a valid deploy whose exported meta conforms to
 * the byte grammar, and every other deploy must leave all four columns NULL. Two
 * failures this pins:
 *
 *   - a value written to the WRONG column (meta_version landing in meta_description
 *     is invisible to arity alone and shows up as garbage on the explorer contract
 *     page, or as a 1406 on a strict server when the longer string meets VARCHAR(32));
 *   - a branch that forgets the columns. createContract is an UPSERT keyed on the
 *     action_index, and a reorg replay or a chunked deploy re-running the same index
 *     takes the UPDATE branch, so an INSERT-only write leaves the row without its
 *     meta on exactly the paths that reconverge a rebuilt DB.
 *
 * Technique: stub doQuery and read back the emitted SQL + args, matching each meta
 * field to its own placeholder by COLUMN POSITION rather than trusting arity, the
 * same way db.createToken-lock-mint-supply.test.js does for the token locks.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../fixtures/config');
const Utility           = require('../../src/utility');
const Database          = require('../../src/db');

const META_COLUMNS = ['meta_name', 'meta_description', 'meta_version', 'meta_json'];

// The four keys deploy.js passes, and the values a conforming Escrow export produces.
const META_PRESENT = {
    META_NAME:        'Escrow',
    META_DESCRIPTION: 'Two-party escrow with an arbiter',
    META_VERSION:     '2.0.0',
    META_JSON:        '{"name":"Escrow","description":"Two-party escrow with an arbiter","version":"2.0.0"}'
};

// column -> the value that key must land in.
const EXPECTED = {
    meta_name:        META_PRESENT.META_NAME,
    meta_description: META_PRESENT.META_DESCRIPTION,
    meta_version:     META_PRESENT.META_VERSION,
    meta_json:        META_PRESENT.META_JSON
};

function makeDb(){
    const config = getTestConfig();
    const util   = new Utility();
    sinon.stub(util, 'logError');
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config, util });
    db.pool = { getConnection: sinon.stub().resolves({
        query:   sinon.stub().resolves([]),
        release: sinon.stub().resolves()
    }) };
    sinon.stub(db, 'createStatus').resolves(7);
    sinon.stub(db, 'getAddressId').resolves(3);
    sinon.stub(db, 'createAddress').resolves(4);
    return db;
}

// Run createContract against a stubbed DB and hand back the emitted (sql, args).
// `existsRows` non-empty drives the UPDATE branch, empty the INSERT branch.
async function runCreateContract(data, existsRows){
    const db = makeDb();
    const dq = sinon.stub(db, 'doQuery');
    dq.onCall(0).resolves(existsRows || []);   // the exists probe
    dq.onCall(1).resolves([]);                 // the write
    await db.createContract(Object.assign({
        ACTION: 'DEPLOY', ACTION_INDEX: 42, SOURCE: 'addr1', BLOCK_INDEX: 900,
        CODE: 'module.exports = {};', CODE_HASH: 'ab'.repeat(32), STATUS: 'valid'
    }, data));
    assert.strictEqual(dq.callCount, 2, 'expected the exists probe plus exactly one write');
    return { sql: String(dq.args[1][0]), args: dq.args[1][1] };
}

// INSERT: the args line up with the column list inside `INSERT INTO contracts ( ... )`.
function insertColumns(sql){
    const m = sql.match(/INSERT\s+INTO\s+contracts\s*\(([\s\S]*?)\)\s*VALUES/i);
    assert.ok(m, 'expected an INSERT INTO contracts (...) VALUES (...) statement');
    return m[1].split(',').map(s => s.trim()).filter(Boolean);
}

// UPDATE: the args line up with the `col=?` assignments in the SET clause, then the
// WHERE key, so a SET-clause position is an args position directly.
function updateSetColumns(sql){
    const m = sql.match(/SET([\s\S]*?)WHERE/i);
    assert.ok(m, 'expected an UPDATE ... SET ... WHERE statement');
    return (m[1].match(/([a-z_]+)\s*=\s*\?/gi) || []).map(s => s.split('=')[0].trim());
}

// The value bound to `column` in the emitted statement, by position.
function boundValue(columns, args, column){
    const i = columns.indexOf(column);
    assert.ok(i >= 0, `${column} is not written by this statement at all`);
    assert.ok(i < args.length, `${column} has no argument bound to its placeholder`);
    return args[i];
}

afterEach(function(){
    sinon.restore();
});

describe('Database.createContract() contract meta manifest @regression @tier1', function(){

    it('INSERT writes all four meta columns, each bound to its own column', async function(){
        const { sql, args } = await runCreateContract(META_PRESENT, []);
        const cols = insertColumns(sql);
        for(const column of META_COLUMNS)
            assert.strictEqual(boundValue(cols, args, column), EXPECTED[column],
                `${column} carried the wrong value on the INSERT path`);
        // The placeholder count must match the column count, or every value after the
        // shortfall is bound one column to the left.
        assert.strictEqual((sql.match(/\?/g) || []).length, cols.length,
            'the INSERT placeholder count no longer matches its column list');
    });

    it('UPDATE writes all four meta columns, each bound to its own column', async function(){
        const { sql, args } = await runCreateContract(META_PRESENT, [{ action_index: 42 }]);
        const cols = updateSetColumns(sql);
        for(const column of META_COLUMNS)
            assert.strictEqual(boundValue(cols, args, column), EXPECTED[column],
                `${column} carried the wrong value on the UPDATE path`);
        // The row key stays last: SET assignments, then the WHERE placeholder.
        assert.strictEqual(args[args.length - 1], 42, 'the UPDATE no longer ends on its action_index key');
    });

    it('a missing meta key is written as NULL, not as undefined or an empty string (INSERT)', async function(){
        const { sql, args } = await runCreateContract({}, []);
        const cols = insertColumns(sql);
        for(const column of META_COLUMNS)
            assert.strictEqual(boundValue(cols, args, column), null,
                `${column} must be NULL when deploy.js passes no meta`);
    });

    it('a missing meta key is written as NULL, not as undefined or an empty string (UPDATE)', async function(){
        const { sql, args } = await runCreateContract({}, [{ action_index: 42 }]);
        const cols = updateSetColumns(sql);
        for(const column of META_COLUMNS)
            assert.strictEqual(boundValue(cols, args, column), null,
                `${column} must be NULL when deploy.js passes no meta`);
    });

    it('an absent optional version does not shift the other three columns', async function(){
        // meta.version is the one optional field, so this is the shape a conforming
        // two-field export actually produces; the other three must keep their columns.
        const partial = Object.assign({}, META_PRESENT);
        delete partial.META_VERSION;
        const { sql, args } = await runCreateContract(partial, []);
        const cols = insertColumns(sql);
        assert.strictEqual(boundValue(cols, args, 'meta_name'), META_PRESENT.META_NAME);
        assert.strictEqual(boundValue(cols, args, 'meta_description'), META_PRESENT.META_DESCRIPTION);
        assert.strictEqual(boundValue(cols, args, 'meta_version'), null);
        assert.strictEqual(boundValue(cols, args, 'meta_json'), META_PRESENT.META_JSON);
    });

    it('the meta write does not disturb the columns the row already carried', async function(){
        const { sql, args } = await runCreateContract(META_PRESENT, []);
        const cols = insertColumns(sql);
        assert.strictEqual(boundValue(cols, args, 'code'), 'module.exports = {};');
        assert.strictEqual(boundValue(cols, args, 'code_hash'), 'ab'.repeat(32));
        assert.strictEqual(boundValue(cols, args, 'action_index'), 42);
        assert.strictEqual(boundValue(cols, args, 'status_id'), 7);
    });
});
