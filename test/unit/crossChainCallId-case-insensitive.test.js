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
 * test/unit/crossChainCallId-case-insensitive.test.js
 *
 * a hub-mirrored call_id can arrive uppercase while every LOCAL write
 * lowercases. The case-insensitive collation lets the SQL prefilter match, but the
 * returned rows are lowercase, so an unnormalized JS Set.has()/Map.get() misses and
 * the same depth-0 call re-executes every block. These tests pin the both-sides
 * lowercasing in db.getEffectiveUndispatchedCalls, db.getEffectiveUnprocessedCallResults
 * (separate-hub JS path), and utility.processCrossChainCalls (expiry-suppression map).
 * All are no-ops for all-lowercase data, so no consensus change on the current chain.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../fixtures/config');
const Utility           = require('../../src/utility');
const Database          = require('../../src/db');

function makeDb(hubDb) {
    const config  = getTestConfig();
    const util    = new Utility();
    sinon.stub(util, 'logError');
    const indexer = { config, util };
    if (hubDb) indexer.hubDb = hubDb;
    return new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', indexer);
}

describe('cross-chain call_id case-insensitive dedup', function () {

    afterEach(() => sinon.restore());

    it('getEffectiveUndispatchedCalls: uppercase mirror call_id filtered by lowercase executions row', async function () {
        const db = makeDb(null); // _mirrorDb() === this
        const UPPER = 'ABCDEF0123456789';
        // First doQuery = mirror dispatch rows; second = local executions lookup (lowercase).
        const doQuery = sinon.stub(db, 'doQuery');
        doQuery.onCall(0).resolves([{ call_id: UPPER, snapshot_block: 1 }]);
        doQuery.onCall(1).resolves([{ call_id: UPPER.toLowerCase() }]);

        const res = await db.getEffectiveUndispatchedCalls('BTC', 'regtest', 1700, 25);
        assert.deepStrictEqual(res, [], 'uppercase mirror call already executed (lowercase row) must be filtered out');
    });

    it('getEffectiveUnprocessedCallResults: uppercase mirror call_id dropped by lowercase callback row', async function () {
        const UPPER = 'ABCDEF0123456789';
        const hubDoQuery = sinon.stub().resolves([{ call_id: UPPER, snapshot_block: 1 }]);
        const db = makeDb({ doQuery: hubDoQuery }); // separate hub mirror -> JS filter path
        sinon.stub(db, 'doQuery').resolves([{ call_id: UPPER.toLowerCase() }]); // already processed

        const res = await db.getEffectiveUnprocessedCallResults('BTC', 'regtest', 1700, 25);
        assert.deepStrictEqual(res.map(r => r.call_id), [], 'processed (lowercase callback) uppercase call must be dropped');
    });

    it('processCrossChainCalls: deliverable uppercase result suppresses expiry of the lowercase request', async function () {
        const UPPER = 'ABCDEF0123456789';
        const util  = new Utility();

        const db = {
            config: { COIN: 'BTC', NETWORK: 'regtest' },
            getEffectiveUndispatchedCalls:     sinon.stub().resolves([]),
            // full effective result set carries the call in UPPERCASE (as a hub mirror might)
            getEffectiveUnprocessedCallResults: sinon.stub().resolves([{ call_id: UPPER, snapshot_block: 1 }]),
            // the expired-request row references the SAME call in canonical lowercase
            getExpiredCrossChainCallRequests:  sinon.stub().resolves([{ call_id: UPPER.toLowerCase() }])
        };

        const processAction = sinon.stub().resolves();
        const actions = {
            processAction,
            actionXcall: {
                processResult:        sinon.stub().resolves(),
                resultSuppressesExpiry: sinon.stub().resolves(true)
            }
        };

        await util.processCrossChainCalls(actions, db, 100, 1000);

        const expiryCalls = processAction.getCalls().filter(c => c.args[0] === 'XCALL');
        assert.strictEqual(expiryCalls.length, 0,
            'a deliverable (verified) result must suppress expiry despite the case mismatch');
    });

    it('processCrossChainCalls: with no matching result the lowercase request still expires (control)', async function () {
        const util = new Utility();
        const db = {
            config: { COIN: 'BTC', NETWORK: 'regtest' },
            getEffectiveUndispatchedCalls:     sinon.stub().resolves([]),
            getEffectiveUnprocessedCallResults: sinon.stub().resolves([]), // no result available
            getExpiredCrossChainCallRequests:  sinon.stub().resolves([{ call_id: 'abcdef0123456789' }])
        };
        const processAction = sinon.stub().resolves();
        const actions = {
            processAction,
            actionXcall: {
                processResult:        sinon.stub().resolves(),
                resultSuppressesExpiry: sinon.stub().resolves(true)
            }
        };

        await util.processCrossChainCalls(actions, db, 100, 1000);

        const expiryCalls = processAction.getCalls().filter(c => c.args[0] === 'XCALL');
        assert.strictEqual(expiryCalls.length, 1, 'no deliverable result => expiry fires');
    });
});
