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
 * test/unit/pricesV2BatchStorage.test.js
 *
 * PRICE batch storage: the `prices` table's four new columns
 * (batch_first_round, batch_last_round, round_count, rounds_json), and their
 * two touch points:
 *
 *   1. Database.createPrice() must carry the four fields through BOTH its
 *      INSERT and its UPDATE arm. Missing one arm is the classic defect here
 *      (spec: oracle-price-batching.md D20/D21, section 5.6).
 *   2. Rollback.rollback() must clear them on a reorg exactly as it clears
 *      the v0 fields. It does so via the SAME mechanism (the generic
 *      dataTables wholesale `DELETE FROM prices WHERE action_index >= ?`),
 *      not a separate v2-specific delete: the whole row goes, so every
 *      column goes with it.
 *
 * No live MariaDB required: doQuery is stubbed on the prototype-borrowed
 * object exactly as test/unit/db.queries.test.js does for createPrice, and
 * Rollback is driven against the mock indexer exactly as test/unit/rollback.test.js
 * does.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig }     = require('../fixtures/config');
const { createMockIndexer } = require('../fixtures/mocks');
const Utility                = require('../../src/utility');
const Database                = require('../../src/db');
const Rollback                 = require('../../src/rollback.js');

function makeDb() {
    const config  = getTestConfig();
    const util    = new Utility();
    sinon.stub(util, 'logError');
    const indexer = { config, util };
    const db      = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', indexer);
    db.pool = { getConnection: sinon.stub().resolves({
        query:            sinon.stub().resolves([]),
        release:          sinon.stub().resolves(),
        beginTransaction: sinon.stub().resolves(),
        commit:           sinon.stub().resolves(),
        rollback:         sinon.stub().resolves()
    }) };
    return db;
}

function makePriceDb(existsRows) {
    const db = makeDb();
    sinon.stub(db, 'createStatus').resolves(1);
    sinon.stub(db, 'getAddressId').resolves(2);
    sinon.stub(db, 'createCoin').resolves(null);
    sinon.stub(db, 'createTicker').resolves(null);
    sinon.stub(db, 'createFiat').resolves(null);
    sinon.stub(db, 'createMemo').resolves(null);
    const dq = sinon.stub(db, 'doQuery');
    dq.onCall(0).resolves(existsRows);
    dq.onCall(1).resolves([]);
    return db;
}

// A representative batch action's data, shaped the way _parseV0 (row 6,
// out of scope here) is expected to hand it to createPrice: ROUND set to
// FIRST_ROUND (D21), plus the four new v2 fields.
const V2_DATA = {
    ACTION_INDEX:       901,
    STATUS:             'valid',
    SOURCE:             'addr1',
    VERSION:            2,
    ROUND:              100,
    BATCH_FIRST_ROUND:  100,
    BATCH_LAST_ROUND:   105,
    ROUND_COUNT:        6,
    ROUNDS_JSON:        '[{"round":100,"timestamp":123,"btc_block_height":100,"pairs":[]}]',
    SIGS_JSON:          '[{"pubkey":"aa","sig":"bb"}]',
};

afterEach(function () { sinon.restore(); });

describe('Database.createPrice() batch columns @regression', function () {

    // Positional, not just presence: the args array has no column names, so a swapped or
    // dropped field would still "include" the right values while binding them to the wrong
    // placeholders. Columns run version, source_id, round_number, round_timestamp, pair_count,
    // pairs_json, sig_count, sigs_json, batch_first_round, batch_last_round, round_count,
    // rounds_json, ... (both arms, per createPrice/prices.sql) - the four v2 fields are args[8..11].
    const V2_SLICE = [100, 105, 6, V2_DATA.ROUNDS_JSON];

    it('INSERT carries all four batch fields, in position', async function () {
        const db = makePriceDb([]);
        await db.createPrice(V2_DATA);
        const sql  = String(db.doQuery.args[1][0]);
        const args = db.doQuery.args[1][1];
        assert.ok(sql.includes('INSERT INTO prices'));
        assert.ok(sql.includes('batch_first_round'), 'INSERT must name batch_first_round');
        assert.ok(sql.includes('batch_last_round'),  'INSERT must name batch_last_round');
        assert.ok(sql.includes('round_count'),        'INSERT must name round_count');
        assert.ok(sql.includes('rounds_json'),         'INSERT must name rounds_json');
        assert.deepStrictEqual(args.slice(8, 12), V2_SLICE,
            'INSERT args[8..11] must be [batch_first_round, batch_last_round, round_count, rounds_json]');
    });

    it('UPDATE carries all four batch fields, in position', async function () {
        const db = makePriceDb([{ action_index: 901 }]);
        await db.createPrice(V2_DATA);
        const sql  = String(db.doQuery.args[1][0]);
        const args = db.doQuery.args[1][1];
        assert.ok(sql.includes('UPDATE prices'));
        assert.ok(sql.includes('batch_first_round=?'), 'UPDATE must SET batch_first_round');
        assert.ok(sql.includes('batch_last_round=?'),  'UPDATE must SET batch_last_round');
        assert.ok(sql.includes('round_count=?'),        'UPDATE must SET round_count');
        assert.ok(sql.includes('rounds_json=?'),         'UPDATE must SET rounds_json');
        assert.deepStrictEqual(args.slice(8, 12), V2_SLICE,
            'UPDATE args[8..11] must be [batch_first_round, batch_last_round, round_count, rounds_json]');
    });

    it('a v0 row (no batch fields present) writes NULL for all four v2 columns, both arms', async function () {
        const v0 = { ACTION_INDEX: 902, STATUS: 'valid', SOURCE: 'addr1', VERSION: 0, ROUND: 50 };

        const insertDb = makePriceDb([]);
        await insertDb.createPrice(v0);
        const insertArgs = insertDb.doQuery.args[1][1];
        // batch_first_round/batch_last_round/round_count/rounds_json sit right after
        // sigs_json (index 7) in both the column list and the args array.
        assert.deepStrictEqual(insertArgs.slice(8, 12), [null, null, null, null],
            'a v0 INSERT must leave all four v2 columns NULL');

        const updateDb = makePriceDb([{ action_index: 902 }]);
        await updateDb.createPrice(v0);
        const updateArgs = updateDb.doQuery.args[1][1];
        assert.deepStrictEqual(updateArgs.slice(8, 12), [null, null, null, null],
            'a v0 UPDATE must leave all four v2 columns NULL');
    });
});

describe('Rollback: prices batch columns clear the same way v0 columns do @regression', function () {

    it('an orphaned batch row is removed by the same wholesale action_index DELETE as a v0 row', async function () {
        const indexer = createMockIndexer();
        indexer.protocolChanges = {
            isDefined: sinon.stub().returns(true),
            isEnabled: sinon.stub().resolves(true),
        };
        const rollback = new Rollback(indexer);

        assert.ok(rollback.dataTables.includes('prices'),
            'prices must stay in the generic dataTables rollback set, or a batch row would ' +
            'survive its own reorg with the OLD v0 columns cleared and the NEW v2 columns intact');

        indexer.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 100 }]); // firstActionIndex
        indexer.indexerDb.doQuery.resolves([]);
        await rollback.rollback(50);

        const calls = indexer.indexerDb.doQuery.getCalls();
        const pricesDelete = calls.find(c => /DELETE FROM prices WHERE action_index >= \?/.test(c.args[0]));
        assert.ok(pricesDelete, 'expected a wholesale DELETE FROM prices WHERE action_index >= ?');
        assert.deepStrictEqual(pricesDelete.args[1], [100],
            'the delete must be bounded at firstActionIndex, orphaning the whole row (v0 and v2 ' +
            'columns alike) with no column-specific carve-out');
    });
});
