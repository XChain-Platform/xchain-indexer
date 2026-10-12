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
 *
 * Seconds-basis getSnapshotAge(): once the oracle_snapshot_age_seconds_activation
 * row is armed, db.getOracleDataForVM reports consensus seconds since the newest
 * admitted finalized snapshot; below it the legacy block-count query runs. The
 * row is armed from genesis on regtest, at a per-chain cut height on testnet, and
 * unarmed on mainnet.
 * Mock-based (doQueryStrict stubbed).
 *
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../../fixtures/config');
const Utility           = require('../../../src/utility');
const Database          = require('../../../src/db');
const gateRegistry      = require('../../../src/consensus/gate_registry');
const ageSeconds        = require('../../../src/db/prices/oracle_snapshot_age_seconds');

function dbFor(network, latestRows, secondsActive = false, coin = 'BTC') {
    if(secondsActive){
        const activeAt = gateRegistry.activeAt.bind(gateRegistry);
        sinon.stub(gateRegistry, 'activeAt').callsFake((key, ...args) =>
            key === ageSeconds.SECONDS_ACTIVATION ? true : activeAt(key, ...args));
    }
    const config   = getTestConfig();
    config.NETWORK = network;
    config.COIN    = coin;
    const util     = new Utility();
    sinon.stub(util, 'logError');
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config, util });
    const calls = [];
    const answer = (query, args) => {
        calls.push({ query, args });
        if (/MAX\(block_timestamp\)\s+AS\s+latest_time/i.test(query)) return Promise.resolve(latestRows || []);
        return Promise.resolve([]);
    };
    sinon.stub(db, 'doQuery').callsFake(answer);
    sinon.stub(db, 'doQueryStrict').callsFake(answer);
    db._calls = calls;
    return db;
}

const secondsCall = (db) => db._calls.find(c => /MAX\(block_timestamp\)\s+AS\s+latest_time/i.test(c.query));
const blocksCall  = (db) => db._calls.find(c => /MAX\(reference_block\)\s+AS\s+latest_block/i.test(c.query));

afterEach(function () { sinon.restore(); });

describe('VM oracle snapshot age in seconds (getOracleDataForVM) @regression @tier1', function () {
    it('an armed row returns block time minus the newest snapshot time', async function () {
        const db = dbFor('regtest', [{ latest_time: 1699999900 }], true);
        const out = await db.getOracleDataForVM(500, 1700000000, 0);
        assert.strictEqual(out.snapshotAge, 100);
        assert.ok(!blocksCall(db), 'the block-count query must not run once armed');
        assert.match(secondsCall(db).query.replace(/\s+/g, ' '), /status = 'finalized' .*reference_block <= \?/);
        assert.strictEqual(secondsCall(db).args[0], 500, 'causal cap bound to the block being processed');
    });

    it('clamps a snapshot stamped after the block to 0', async function () {
        const db = dbFor('regtest', [{ latest_time: 1700000050 }], true);
        const out = await db.getOracleDataForVM(500, 1700000000, 0);
        assert.strictEqual(out.snapshotAge, 0);
    });

    it('reports MAX_SAFE_INTEGER with no admitted snapshot', async function () {
        for (const rows of [[], [{ latest_time: null }]]) {
            sinon.restore();
            const db = dbFor('regtest', rows, true);
            const out = await db.getOracleDataForVM(500, 1700000000, 0);
            assert.strictEqual(out.snapshotAge, Number.MAX_SAFE_INTEGER);
        }
    });

    it('reports MAX_SAFE_INTEGER when the block time is unknown', async function () {
        const db = dbFor('regtest', [{ latest_time: 1699999900 }], true);
        const out = await db.getOracleDataForVM(500, NaN, 0);
        assert.strictEqual(out.snapshotAge, Number.MAX_SAFE_INTEGER);
    });

    it('the row is unarmed on mainnet, armed per testnet chain, and armed from genesis on regtest', function () {
        const UNARMED = 9999999999;
        const row = gateRegistry.registry.get(ageSeconds.SECONDS_ACTIVATION);
        assert.strictEqual(row.mainnet, UNARMED);
        assert.strictEqual(row.regtest, 0);
        // Each testnet chain's height is read from the registry so the next cut moves it without a test edit.
        for (const coin of ['BTC', 'LTC', 'DOGE']) {
            const armed = row[coin + ':testnet'];
            assert.ok(Number.isSafeInteger(armed) && armed > 1 && armed < UNARMED, coin + ' ' + armed);
        }
    });

    // Mainnet must behave exactly as before the row was ratified: the block-count
    // query, and no seconds query, on every coin at any real height.
    it('mainnet keeps the legacy block-count query on every coin', async function () {
        for (const coin of ['BTC', 'LTC', 'DOGE']) {
            sinon.restore();
            const db = dbFor('mainnet', [{ latest_time: 1699999900 }], false, coin);
            await db.getOracleDataForVM(1000000000, 1700000000, 0);
            assert.ok(blocksCall(db), coin + ' mainnet must keep the block-count age query');
            assert.ok(!secondsCall(db), coin + ' mainnet must not run the seconds query');
        }
    });

    // No gate stub here: the shipped testnet row decides the basis on each side of its height.
    it('testnet keeps the block-count query at height 1 and reports seconds from the armed height', async function () {
        const row = gateRegistry.registry.get(ageSeconds.SECONDS_ACTIVATION);
        for (const coin of ['BTC', 'LTC', 'DOGE']) {
            const armed = row[coin + ':testnet'];
            sinon.restore();
            const below = dbFor('testnet', [{ latest_time: 1699999900 }], false, coin);
            await below.getOracleDataForVM(1, 1700000000, 0);
            assert.ok(blocksCall(below), coin + ' testnet at height 1 must keep the block-count age query');
            assert.ok(!secondsCall(below), coin + ' testnet at height 1 must not run the seconds query');
            sinon.restore();
            const above = dbFor('testnet', [{ latest_time: 1699999900 }], false, coin);
            const out = await above.getOracleDataForVM(armed, 1700000000, 0);
            assert.strictEqual(out.snapshotAge, 100, coin + ' testnet at the armed height reports seconds');
            assert.ok(!blocksCall(above), coin + ' testnet at the armed height must not run the block-count query');
        }
    });

    // No gate stub here: this is the shipped regtest row deciding the basis.
    it('regtest reports seconds from genesis on every coin', async function () {
        for (const coin of ['BTC', 'LTC', 'DOGE']) {
            for (const height of [0, 1, 500]) {
                sinon.restore();
                const db = dbFor('regtest', [{ latest_time: 1699999900 }], false, coin);
                const out = await db.getOracleDataForVM(height, 1700000000, 0);
                assert.strictEqual(out.snapshotAge, 100, coin + ' regtest at ' + height + ' must report seconds');
                assert.ok(!blocksCall(db), coin + ' regtest must not run the block-count query');
            }
        }
    });

    // Off the reference chain the height cap bounds nothing, so the seconds read
    // must carry the same consensus-time bound as the other preload reads.
    it('regtest off the reference chain keeps the consensus-time bound on the seconds read', async function () {
        const db = dbFor('regtest', [{ latest_time: 1699999900 }], false, 'DOGE');
        await db.getOracleDataForVM(6319000, 1700000000, 0);
        const c = secondsCall(db);
        assert.match(c.query.replace(/\s+/g, ' '), /reference_block <= \?/);
        assert.match(c.query.replace(/\s+/g, ' '), /block_timestamp <= \?/);
        assert.ok(c.args.includes(1700000000), 'the block time must be the bound argument');
    });
});
