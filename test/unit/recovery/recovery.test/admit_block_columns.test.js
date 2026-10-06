'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// AnchorRecovery admission heights: cross_chain_matches and cross_chain_calls
// rebuilt from the archive carry admit_block_btc/ltc/doge when the archived row
// has them, and stay at the legacy NULL when it does not.

process.env.INDEXER_COIN = 'DOGE';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');

const AnchorRecovery = require('../../../../bin/recovery.js');
const { makeKeypair, buildBatch, rawMatch, rawCall } = require('../../../fixtures/anchor-archive.js');
const { util, memDb } = require('../../../helpers/recovery_stubs.js');

const quiet = { log: () => {}, util };
const ADMIT = /^UPDATE (cross_chain_matches|cross_chain_calls) SET admit_block_btc = \?, admit_block_ltc = \?, admit_block_doge = \?/;

let oracleKeys, crossKeys;

// memDb with every admission-height UPDATE recorded alongside its table and params.
function recordingDb(v1s) {
    let db = memDb(v1s, []);
    let writes = [];
    let inner = db.doQuery;
    db.doQuery = async function (sql, params) {
        let hit = ADMIT.exec(sql.replace(/\s+/g, ' '));
        if (hit) writes.push({ table: hit[1], params });
        return inner.call(this, sql, params);
    };
    db.admitWrites = writes;
    return db;
}

describe('AnchorRecovery admission heights @regression @tier2', function () {
    beforeEach(function () {
        oracleKeys = [makeKeypair(), makeKeypair(), makeKeypair(), makeKeypair()];
        crossKeys  = [makeKeypair(), makeKeypair(), makeKeypair(), makeKeypair()];
    });

    it('writes the archived admit_block triple onto a rebuilt match', async function () {
        let m = Object.assign(rawMatch('m1'), { admit_block_btc: 101, admit_block_ltc: null, admit_block_doge: 7 });
        let { v1 } = buildBatch(0, [m], oracleKeys, crossKeys);
        let db = recordingDb([v1]);
        let report = await new AnchorRecovery(db, quiet).run();

        assert.strictEqual(report.failed.length, 0);
        assert.strictEqual(report.matches, 1);
        assert.deepStrictEqual(db.admitWrites, [
            { table: 'cross_chain_matches', params: [101, null, 7, 'm1'] }]);
    });

    it('writes the archived admit_block triple onto rebuilt call rows, keyed by call_id and phase', async function () {
        let calls = [rawCall('c1', 'dispatch', { admit_block_btc: 55, admit_block_ltc: 56, admit_block_doge: 57 }),
                     rawCall('c1', 'result')];
        let { v1 } = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys, { calls });
        let db = recordingDb([v1]);
        let report = await new AnchorRecovery(db, quiet).run();

        assert.strictEqual(report.failed.length, 0);
        assert.strictEqual(report.calls, 2);
        assert.deepStrictEqual(db.admitWrites, [
            { table: 'cross_chain_calls', params: [55, 56, 57, 'c1', 'dispatch'] }]);
    });

    it('leaves a legacy archive row at NULL admission heights', async function () {
        let { v1 } = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys, { calls: [rawCall('c1', 'dispatch')] });
        let db = recordingDb([v1]);
        let report = await new AnchorRecovery(db, quiet).run();

        assert.strictEqual(report.matches, 1);
        assert.strictEqual(report.calls, 1);
        assert.deepStrictEqual(db.admitWrites, []);
    });

    it('upgrades the admission heights when a later batch re-finalizes the same match and call', async function () {
        let first = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys, { calls: [rawCall('c1', 'dispatch')] });
        let m = Object.assign(rawMatch('m1'), { admit_block_btc: 120 });
        let c = rawCall('c1', 'dispatch', { admit_block_btc: 121 });
        let second = buildBatch(1, [m], oracleKeys, crossKeys, { calls: [c] });
        let db = recordingDb([first.v1, second.v1]);
        await new AnchorRecovery(db, quiet).run();

        assert.deepStrictEqual(db.admitWrites, [
            { table: 'cross_chain_matches', params: [120, null, null, 'm1'] },
            { table: 'cross_chain_calls', params: [121, null, null, 'c1', 'dispatch'] }]);
    });
});
