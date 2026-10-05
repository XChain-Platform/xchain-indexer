// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const rederive = require('../../src/rollback/rederive.js');
const sweeps = require('../../src/rollback/sweeps.js');

function queryLog(db){
    return db.doQuery.getCalls().map(call => ({ sql: call.args[0], args: call.args[1] }));
}

function assertReadsBeforeDeletes(log, readTables){
    let deletes = log.filter(entry => /^DELETE FROM/.test(entry.sql));
    assert.ok(deletes.length > 0, 'expected sweep deletes');
    for(let table of readTables){
        let readIndex = log.findIndex(entry => entry.sql === `SELECT MAX(id) AS max_id FROM ${table}`);
        assert.ok(readIndex >= 0, `expected ${table} maximum read`);
        for(let deletion of deletes){
            assert.ok(readIndex < log.indexOf(deletion), `${table} maximum must be read before ${deletion.sql}`);
        }
    }
    for(let deletion of deletes){
        assert.match(deletion.sql, /> \?/, `${deletion.sql} must be maximum-id bounded`);
    }
}

async function runDanglingSweep(maxima){
    let db = {
        doQuery: sinon.stub().callsFake(async sql => {
            if(sql.endsWith('FROM index_addresses')) return maxima.addresses;
            if(sql.endsWith('FROM index_tickers')) return maxima.tickers;
            return { affectedRows: 1 };
        }),
    };
    await sweeps.sweepDanglingIndexReferences.call({
        indexerDb: db,
        recordSweepStats: sinon.stub(),
    });
    return queryLog(db);
}

async function runIconSweep(tokens){
    let db = {
        doQuery: sinon.stub().callsFake(async sql => {
            if(sql.endsWith('FROM tokens')) return tokens;
            return { affectedRows: 1 };
        }),
    };
    await rederive.sweepOrphanedIcons.call({
        indexerDb: db,
        recordSweepStats: sinon.stub(),
    });
    return queryLog(db);
}

describe('Scoped rollback orphan sweeps', function () {
    it('reads surviving maxima before issuing bounded deletes', async function () {
        let dangling = await runDanglingSweep({
            addresses: [{ max_id: 41 }],
            tickers: [{ max_id: 19 }],
        });
        assertReadsBeforeDeletes(dangling, ['index_addresses', 'index_tickers']);

        let deletes = dangling.filter(entry => /^DELETE FROM/.test(entry.sql));
        assert.deepStrictEqual(deletes.map(entry => entry.args), [
            [41, 19],
            [19, 0, 19, 0],
            [41],
        ]);

        let icons = await runIconSweep([{ max_id: 7 }]);
        assertReadsBeforeDeletes(icons, ['tokens']);
        assert.deepStrictEqual(icons.find(entry => /^DELETE FROM/.test(entry.sql)).args, [7]);
    });

    it('uses zero when a surviving maximum is missing', async function () {
        let dangling = await runDanglingSweep({
            addresses: [],
            tickers: [{ max_id: null }],
        });
        let deletes = dangling.filter(entry => /^DELETE FROM/.test(entry.sql));
        assert.deepStrictEqual(deletes.map(entry => entry.args), [
            [0, 0],
            [0, 0, 0, 0],
            [0],
        ]);

        let icons = await runIconSweep([{ max_id: null }]);
        assert.deepStrictEqual(icons.find(entry => /^DELETE FROM/.test(entry.sql)).args, [0]);
    });
});
