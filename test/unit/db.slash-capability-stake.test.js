/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 * test/unit/db.slash-capability-stake.test.js
 *
 * SLASH-1: slashCapabilityStake Pass 1 filtered `activation_block <= block`, so an
 * equivocator's pending-activation top-up (debited at STAKE time) escaped the bond
 * burn and could later be UNSTAKEd/refunded. At/after the SLASH_BURNS_PENDING_STAKE
 * flag-day the caller passes burnPending=true and the whole locked bond burns,
 * activated or not. These mock-based tests (doQuery stubbed) lock the query shape in
 * both regimes and confirm a pending row is zeroed when burnPending is set.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../fixtures/config');
const Utility           = require('../../src/utility');
const Database          = require('../../src/db');

function makeDb(stakeRows) {
    const config = getTestConfig();
    const util   = new Utility();
    sinon.stub(util, 'logError');
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config, util });
    const calls = [];
    sinon.stub(db, 'getStatusId').callsFake(async (s) => (s === 'valid' ? 1 : (s === 'pending' ? 2 : null)));
    sinon.stub(db, 'doQuery').callsFake((query, args) => {
        calls.push({ query, args });
        // Only the Pass-1 stakes SELECT returns rows; Pass-2 (unstakes) + the UPDATEs/INSERTs are empty.
        if (/FROM stakes\b/.test(query)) return Promise.resolve(stakeRows || []);
        return Promise.resolve([]);
    });
    db._calls = calls;
    return db;
}

afterEach(() => sinon.restore());

describe('slashCapabilityStake burn-pending gate (SLASH-1) @regression @tier1', function () {

    function stakesSelect(db) {
        return db._calls.find(c => /FROM stakes\b/.test(c.query));
    }

    it('below the flag (burnPending=false) keeps the activation_block filter', async function () {
        const db = makeDb([]);
        await db.slashCapabilityStake(7, 200, 999, false);
        const q = stakesSelect(db);
        assert.match(q.query, /activation_block <= \?/, 'legacy path gates on activation');
        assert.ok(q.args.includes(200), 'blockIndex bound for the activation filter');
        assert.match(q.query, /deactivation_block IS NULL/, 'double-burn guard stays');
    });

    it('at/after the flag (burnPending=true) drops the activation_block filter', async function () {
        const db = makeDb([]);
        await db.slashCapabilityStake(7, 200, 999, true);
        const q = stakesSelect(db);
        assert.doesNotMatch(q.query, /activation_block <= \?/, 'pending stakes are no longer excluded');
        assert.match(q.query, /deactivation_block IS NULL/, 'double-burn guard still stays');
        assert.deepStrictEqual(q.args, [7, 1], 'only pubkeyId + valid_id bound (no blockIndex activation arg)');
    });

    it('burns a pending-activation stake row when burnPending=true', async function () {
        // A pending top-up (activation_block > slash block) is returned by the capped query and zeroed.
        const db = makeDb([{ action_index: 51, amount: '500.00000000' }]);
        const burned = await db.slashCapabilityStake(7, 200, 999, true);
        const updates = db._calls.filter(c => /UPDATE stakes SET amount/.test(c.query));
        assert.strictEqual(updates.length, 1, 'the pending row is zeroed');
        assert.ok(db.util.bcgt(burned, '0'), 'the pending row contributes to the burned total');
    });
});
