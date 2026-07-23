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
 * test/unit/db.oracle-snapshot-age-causality.test.js
 *
 * VM oracle getSnapshotAge() causality flag-day (see
 * src/oracle_snapshot_age_causality_activation.js). db.getOracleDataForVM's age
 * query (MAX(reference_block) of finalized snapshots) must be causally capped at
 * the block being processed, like every sibling query in the same function;
 * uncapped, a replay observes a FUTURE snapshot and computes a different
 * (clamped-to-0) getSnapshotAge, a VM-visible consensus fork. The cap re-evaluates
 * already-processed blocks, so it is height-gated. These tests are mock-based
 * (doQuery stubbed) and lock (ARMED 2026-07-22 at the ratified deploy-train
 * heights BTC 961000 / LTC 3154250 / DOGE 6319000; testnet + regtest genesis):
 *   - the GATE: uncapped age query when inert, `reference_block <= ?` when active;
 *   - regtest + testnet active from genesis; mainnet inert below its per-coin
 *     height and capped at/after it;
 *   - the activation-module predicate itself (per-coin mainnet boundary,
 *     genesis testnet, unknown/bad input -> off).
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../fixtures/config');
const Utility           = require('../../src/utility');
const Database          = require('../../src/db');
const sac               = require('../../src/oracle_snapshot_age_causality_activation');

function dbFor(network, coin) {
    const config   = getTestConfig();
    config.NETWORK = network;
    config.COIN    = coin || 'BTC';
    const util     = new Utility();
    sinon.stub(util, 'logError');
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config, util });
    const calls = [];
    sinon.stub(db, 'doQuery').callsFake((query, args) => { calls.push({ query, args }); return Promise.resolve([]); });
    db._calls = calls;
    return db;
}

// The age query is the one selecting MAX(reference_block) AS latest_block.
function ageCall(db) {
    const hit = db._calls.find(c => /MAX\(reference_block\)\s+AS\s+latest_block/i.test(c.query));
    assert.ok(hit, 'getOracleDataForVM did not emit its snapshot-age query');
    return hit;
}

afterEach(function () { sinon.restore(); });

describe('VM oracle snapshot-age causality gate (getOracleDataForVM age query) @regression @tier1', function () {

    describe('gate: which age query is emitted', function () {

        it('regtest (genesis-armed) causally caps the age query at the processing block', async function () {
            const db = dbFor('regtest');
            await db.getOracleDataForVM(500, 1700000000, 0);
            const c = ageCall(db);
            assert.match(c.query.replace(/\s+/g, ' '), /WHERE status = 'finalized' AND reference_block <= \?/,
                'active: age query must carry the causal cap');
            assert.deepStrictEqual(c.args, [500], 'cap bound to the block being processed (blockCap = blockIndex)');
        });

        it('mainnet BELOW its per-coin height is INERT: age query stays uncapped (byte-identical replay)', async function () {
            const db = dbFor('mainnet', 'BTC');           // BTC:mainnet armed at 961000
            await db.getOracleDataForVM(500, 1700000000, 0);
            const c = ageCall(db);
            assert.doesNotMatch(c.query, /reference_block <= \?/, 'below the armed height mainnet must NOT cap the age query');
            assert.ok(c.args === undefined, 'legacy call passes no args (byte-identical to the pre-gate call)');
        });

        it('mainnet AT/ABOVE its per-coin height caps the age query', async function () {
            const db = dbFor('mainnet', 'BTC');
            await db.getOracleDataForVM(961000, 1700000000, 0);
            const c = ageCall(db);
            assert.match(c.query.replace(/\s+/g, ' '), /WHERE status = 'finalized' AND reference_block <= \?/,
                'at/after the armed height the age query must carry the causal cap');
            assert.deepStrictEqual(c.args, [961000], 'cap bound to the block being processed');
        });

        it('testnet is genesis-active (armed from 0): age query is capped', async function () {
            const db = dbFor('testnet');
            await db.getOracleDataForVM(500, 1700000000, 0);
            const c = ageCall(db);
            assert.match(c.query.replace(/\s+/g, ' '), /WHERE status = 'finalized' AND reference_block <= \?/,
                'pre-launch testnet caps from genesis (matches PKG3_SANDBOX_ACTIVATION)');
            assert.deepStrictEqual(c.args, [500]);
        });
    });

    describe('activation-module predicate', function () {

        it('regtest is active from genesis at any block height', function () {
            assert.strictEqual(sac.isOracleSnapshotAgeCausalityActive(0, 'regtest', 'BTC'), true);
            assert.strictEqual(sac.isOracleSnapshotAgeCausalityActive(999999, 'regtest', 'BTC'), true);
        });

        it('mainnet is armed per coin: inert below the height, active at/after it', function () {
            // BTC 961000, LTC 3154250, DOGE 6319000
            assert.strictEqual(sac.isOracleSnapshotAgeCausalityActive(960999, 'mainnet', 'BTC'), false);
            assert.strictEqual(sac.isOracleSnapshotAgeCausalityActive(961000, 'mainnet', 'BTC'), true);
            assert.strictEqual(sac.isOracleSnapshotAgeCausalityActive(3154249, 'mainnet', 'LTC'), false);
            assert.strictEqual(sac.isOracleSnapshotAgeCausalityActive(3154250, 'mainnet', 'LTC'), true);
            assert.strictEqual(sac.isOracleSnapshotAgeCausalityActive(6318999, 'mainnet', 'DOGE'), false);
            assert.strictEqual(sac.isOracleSnapshotAgeCausalityActive(6319000, 'mainnet', 'DOGE'), true);
        });

        it('testnet is genesis-active for every coin (pre-launch cohort)', function () {
            assert.strictEqual(sac.isOracleSnapshotAgeCausalityActive(0, 'testnet', 'BTC'), true);
            assert.strictEqual(sac.isOracleSnapshotAgeCausalityActive(0, 'testnet', 'DOGE'), true);
            assert.strictEqual(sac.isOracleSnapshotAgeCausalityActive(999999999, 'testnet', 'LTC'), true);
        });

        it('unknown network or unparseable height is off (safe: keeps deployed behavior)', function () {
            assert.strictEqual(sac.isOracleSnapshotAgeCausalityActive(0, 'stagenet', 'BTC'), false);
            assert.strictEqual(sac.isOracleSnapshotAgeCausalityActive('nonsense', 'regtest', 'BTC'), false);
            assert.strictEqual(sac.isOracleSnapshotAgeCausalityActive(undefined, 'regtest', 'BTC'), false);
        });
    });
});
