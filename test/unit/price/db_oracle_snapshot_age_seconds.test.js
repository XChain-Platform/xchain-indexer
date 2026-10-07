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
 * admitted finalized snapshot; below it the legacy block-count query runs.
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

function dbFor(network, latestRows) {
    const config   = getTestConfig();
    config.NETWORK = network;
    config.COIN    = 'BTC';
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
    it('regtest (armed from genesis) returns block time minus the newest snapshot time', async function () {
        const db = dbFor('regtest', [{ latest_time: 1699999900 }]);
        const out = await db.getOracleDataForVM(500, 1700000000, 0);
        assert.strictEqual(out.snapshotAge, 100);
        assert.ok(!blocksCall(db), 'the block-count query must not run once armed');
        assert.match(secondsCall(db).query.replace(/\s+/g, ' '), /status = 'finalized' .*reference_block <= \?/);
        assert.strictEqual(secondsCall(db).args[0], 500, 'causal cap bound to the block being processed');
    });

    it('clamps a snapshot stamped after the block to 0', async function () {
        const db = dbFor('regtest', [{ latest_time: 1700000050 }]);
        const out = await db.getOracleDataForVM(500, 1700000000, 0);
        assert.strictEqual(out.snapshotAge, 0);
    });

    it('reports MAX_SAFE_INTEGER with no admitted snapshot', async function () {
        for (const rows of [[], [{ latest_time: null }]]) {
            sinon.restore();
            const db = dbFor('regtest', rows);
            const out = await db.getOracleDataForVM(500, 1700000000, 0);
            assert.strictEqual(out.snapshotAge, Number.MAX_SAFE_INTEGER);
        }
    });

    it('reports MAX_SAFE_INTEGER when the block time is unknown', async function () {
        const db = dbFor('regtest', [{ latest_time: 1699999900 }]);
        const out = await db.getOracleDataForVM(500, NaN, 0);
        assert.strictEqual(out.snapshotAge, Number.MAX_SAFE_INTEGER);
    });

    it('mainnet and testnet are unarmed: the legacy block-count query runs', async function () {
        for (const network of ['mainnet', 'testnet']) {
            sinon.restore();
            const db = dbFor(network);
            await db.getOracleDataForVM(1000000000, 1700000000, 0);
            assert.ok(blocksCall(db), network + ' must keep the block-count age query');
            assert.ok(!secondsCall(db), network + ' must not run the seconds query');
        }
    });
});
