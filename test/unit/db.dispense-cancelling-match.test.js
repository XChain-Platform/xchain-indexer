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
 * test/unit/db.dispense-cancelling-match.test.js
 *
 * DISPENSE cancelling-dispenser match flag-day (see
 * src/dispense_cancelling_match_activation.js). findMatchingDispensers'
 * latest-status MAX(action_index) subquery must correlate on the DISPENSER's
 * action index (d1.action_index) like every sibling query; the legacy predicate
 * correlated on the STATUS row's own action index (s1.action_index), so a
 * dispenser gained a second ('cancelling') status row and then matched NOTHING,
 * silently dropping coin-paid DISPENSE triggers during DISPENSER_CLOSE_DELAY.
 * Because the corrected correlation changes how already-valid blocks evaluate,
 * it is time-gated. These tests are mock-based (doQuery stubbed) and lock:
 *   - the GATE: legacy correlation below the mainnet flag-day, corrected at/after;
 *   - testnet/regtest active from genesis (2.0.0-cohort semantics);
 *   - the activation-module predicate itself (unknown network / bad time -> off).
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../fixtures/config');
const Utility           = require('../../src/utility');
const Database          = require('../../src/db');
const dcm               = require('../../src/dispense_cancelling_match_activation');

const FLAG_DAY = dcm.DISPENSE_CANCELLING_MATCH_ACTIVATION.mainnet; // 1790812800

// Build a Database with an injected config + a captured doQuery.
function dbFor(network) {
    const config  = getTestConfig();
    config.NETWORK = network;
    config.COIN    = 'BTC';
    const util    = new Utility();
    sinon.stub(util, 'logError');
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config, util });
    const calls = [];
    sinon.stub(db, 'doQuery').callsFake((query, args) => { calls.push({ query, args }); return Promise.resolve([]); });
    db._calls = calls;
    return db;
}

// The main dispenser-match query is the one that joins dispenser_statuses.
function matchQuery(db) {
    const hit = db._calls.find(c => /FROM\s+dispensers d1/.test(c.query));
    assert.ok(hit, 'findMatchingDispensers did not emit its dispenser-match query');
    return hit.query.replace(/\s+/g, ' ');
}

function dispenseData(blockTime) {
    return {
        COIN: 'BTC', COIN_TICK: null, COIN_DESTINATION: 'addr1',
        COIN_AMOUNT: '1', BLOCK_TIME: blockTime, BLOCK_INDEX: 100, ACTION_INDEX: 1
    };
}

afterEach(function () { sinon.restore(); });

describe('DISPENSE cancelling-match gate (findMatchingDispensers latest-status correlation) @regression @tier1', function () {

    describe('gate: which correlation is emitted', function () {

        it('mainnet below the flag-day keeps the legacy status-row correlation (byte-identical replay)', async function () {
            const db = dbFor('mainnet');
            await db.findMatchingDispensers(dispenseData(FLAG_DAY - 1));
            const q = matchQuery(db);
            assert.match(q, /s4\.dispenser_action_index=s1\.action_index/, 'legacy correlation below activation');
            assert.doesNotMatch(q, /s4\.dispenser_action_index=d1\.action_index/, 'corrected correlation must NOT leak below activation');
        });

        it('mainnet at/after the flag-day correlates on the dispenser action index (sibling idiom)', async function () {
            const db = dbFor('mainnet');
            await db.findMatchingDispensers(dispenseData(FLAG_DAY));
            const q = matchQuery(db);
            assert.match(q, /s4\.dispenser_action_index=d1\.action_index/, 'corrected correlation at/after activation');
            assert.doesNotMatch(q, /s4\.dispenser_action_index=s1\.action_index/, 'legacy correlation must be gone at/after activation');
        });

        it('regtest is corrected from genesis', async function () {
            const db = dbFor('regtest');
            await db.findMatchingDispensers(dispenseData(1));
            assert.match(matchQuery(db), /s4\.dispenser_action_index=d1\.action_index/);
        });

        it('testnet is corrected from genesis', async function () {
            const db = dbFor('testnet');
            await db.findMatchingDispensers(dispenseData(1));
            assert.match(matchQuery(db), /s4\.dispenser_action_index=d1\.action_index/);
        });

        it('the cancelling filter the fix un-deadens is still present', async function () {
            const db = dbFor('regtest');
            await db.findMatchingDispensers(dispenseData(1));
            assert.match(matchQuery(db), /s3\.status IN \('open', 'cancelling'\)/,
                'status IN (open, cancelling) filter must stay; the corrected correlation is what makes its cancelling branch live');
        });
    });

    describe('activation-module predicate', function () {

        it('flips exactly at the mainnet flag-day', function () {
            assert.strictEqual(dcm.isDispenseCancellingMatchActive(FLAG_DAY - 1, 'mainnet'), false);
            assert.strictEqual(dcm.isDispenseCancellingMatchActive(FLAG_DAY, 'mainnet'), true);
        });

        it('testnet/regtest are active from genesis', function () {
            assert.strictEqual(dcm.isDispenseCancellingMatchActive(0, 'testnet'), true);
            assert.strictEqual(dcm.isDispenseCancellingMatchActive(0, 'regtest'), true);
        });

        it('unknown network or unparseable time is off (safe: keeps deployed behavior)', function () {
            assert.strictEqual(dcm.isDispenseCancellingMatchActive(FLAG_DAY, 'stagenet'), false);
            assert.strictEqual(dcm.isDispenseCancellingMatchActive(undefined, 'mainnet'), false);
            assert.strictEqual(dcm.isDispenseCancellingMatchActive('nonsense', 'mainnet'), false);
        });
    });
});
