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
 * test/unit/db.dispenser-caps-counts.test.js
 *
 * DISPENSER caps derived counts (dispenser_caps_activation.js / ).
 * getDispenserRefillCount and getDispenserDispenseCount are DERIVED from the
 * existing dispenser_edits / dispenses tables (no mutable counter, no migration):
 * a reorg that deletes those rows automatically corrects the count. These tests
 * mock doQuery and lock the query shape + count/reset semantics.
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
    const config = getTestConfig();
    const util   = new Utility();
    sinon.stub(util, 'logError');
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config, util });
    return db;
}

afterEach(function () { sinon.restore(); });

describe('DISPENSER caps derived counts @regression @tier1', function () {

    describe('getDispenserRefillCount', function () {
        it('counts only VALID refills (give_escrow > 0) for the dispenser', async function () {
            const db = makeDb();
            const q = sinon.stub(db, 'doQuery').resolves([{ c: 3 }]);
            const n = await db.getDispenserRefillCount(50);
            assert.strictEqual(n, 3);
            const [query, args] = q.firstCall.args;
            assert.match(query.replace(/\s+/g, ' '),
                /FROM dispenser_edits e .* s\.status='valid' AND e\.give_escrow IS NOT NULL AND e\.give_escrow > 0/);
            assert.deepStrictEqual(args, [50]);
        });

        it('returns 0 for a dispenser with no refills', async function () {
            const db = makeDb();
            sinon.stub(db, 'doQuery').resolves([{ c: 0 }]);
            assert.strictEqual(await db.getDispenserRefillCount(50), 0);
        });
    });

    describe('getDispenserDispenseCount (since last refill)', function () {
        it('counts valid dispenses AFTER the most recent refill action_index (reset semantics)', async function () {
            const db = makeDb();
            const q = sinon.stub(db, 'doQuery');
            q.onCall(0).resolves([{ r: 777 }]);  // most recent refill at action_index 777
            q.onCall(1).resolves([{ c: 42 }]);   // 42 valid dispenses after it

            const n = await db.getDispenserDispenseCount(50);
            assert.strictEqual(n, 42);

            // Second query must count dispenses strictly after the refill index.
            const [countQuery, countArgs] = q.secondCall.args;
            assert.match(countQuery.replace(/\s+/g, ' '),
                /FROM dispenses d .* s\.status='valid' AND d\.action_index > \?/);
            assert.deepStrictEqual(countArgs, [50, 777]);
        });

        it('counts ALL valid dispenses (since 0) when the dispenser was never refilled', async function () {
            const db = makeDb();
            const q = sinon.stub(db, 'doQuery');
            q.onCall(0).resolves([{ r: null }]); // no refill
            q.onCall(1).resolves([{ c: 5 }]);

            const n = await db.getDispenserDispenseCount(50);
            assert.strictEqual(n, 5);
            assert.deepStrictEqual(q.secondCall.args[1], [50, 0]);
        });
    });
});
