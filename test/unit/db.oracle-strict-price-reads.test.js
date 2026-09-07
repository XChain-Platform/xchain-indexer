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
 * test/unit/db.oracle-strict-price-reads.test.js
 *
 * The price-barrier-guarded reads are consensus INPUTS and must fail loudly.
 *
 * Database.doQuery catches a driver error and returns [] whenever the instance
 * holds no transaction connection. Every one of these reads runs on the hub-DB
 * instance, which never opens a transaction (XChainIndexer builds it for reads
 * only), so a transient fault - a lock wait timeout, errno 1205, is the shape the
 * item reported - comes back as "no rows", which is indistinguishable from an
 * oracle that genuinely published nothing. For getOracleDataForVM that empty
 * result becomes an absent `prices` map and a Number.MAX_SAFE_INTEGER
 * `snapshotAge`, both of which the VM hashes into block state: one node's DB
 * hiccup forks it from the fleet. getLatestPrice was already converted to the
 * throwing helper for this reason (M-17); these tests pin the rest of the class.
 *
 * The negative control is the point of the file: with doQueryStrict swapped back
 * to doQuery in any one of these methods, that method resolves to empty data and
 * its case here goes red.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../fixtures/config');
const Utility           = require('../../src/utility');
const Database          = require('../../src/db');

// A Database on a NON-transactional instance (hubDb's shape) whose every query
// rejects the way a lock wait timeout does.
function faultingDb() {
    const config = getTestConfig();
    const util   = new Utility();
    sinon.stub(util, 'logError');
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config, util });
    assert.strictEqual(db.transactionConnection, null,
        'the hub instance holds no transaction, which is what makes the swallow reachable');
    const fault = Object.assign(new Error('Lock wait timeout exceeded; try restarting transaction'),
        { errno: 1205, code: 'ER_LOCK_WAIT_TIMEOUT', sqlState: 'HY000' });
    const released = { count: 0 };
    sinon.stub(db, 'getConnection').resolves({
        query:   () => Promise.reject(fault),
        release: () => { released.count++; return Promise.resolve(); }
    });
    db._released = released;
    return db;
}

// The same instance, but with exactly ONE of the preload's reads faulting and the
// rest answering empty. Four reads share getOracleDataForVM, so a blanket fault
// proves only that SOME read is strict: converting three of the four would still
// pass it. This is what makes each read's conversion individually load-bearing.
function dbFaultingOnly(pattern) {
    const config = getTestConfig();
    const util   = new Utility();
    sinon.stub(util, 'logError');
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config, util });
    const fault = Object.assign(new Error('Lock wait timeout exceeded; try restarting transaction'),
        { errno: 1205, code: 'ER_LOCK_WAIT_TIMEOUT', sqlState: 'HY000' });
    const seen = [];
    sinon.stub(db, 'getConnection').resolves({
        query: (sql) => {
            seen.push(sql);
            return pattern.test(String(sql)) ? Promise.reject(fault) : Promise.resolve([]);
        },
        release: () => Promise.resolve()
    });
    db._seen = seen;
    return db;
}

async function rejects(fn) {
    try { await fn(); }
    catch (err) { return err; }
    return null;
}

afterEach(function () { sinon.restore(); });

describe('price-barrier-guarded reads fail loudly on a DB fault @regression @tier1', function () {

    it('getOracleDataForVM rejects rather than handing the VM an empty oracle', async function () {
        const db  = faultingDb();
        const err = await rejects(() => db.getOracleDataForVM(500, 1700000000, 1800));
        assert.ok(err, 'a failed preload must not resolve at all');
        assert.strictEqual(err.errno, 1205, 'and it must surface the driver error, not a substitute');
    });

    it('never resolves the shape a swallowed fault used to produce', async function () {
        // The exact fake-success this file exists to stop: {} prices with a
        // MAX_SAFE_INTEGER age, which reads to a contract as "the oracle has never
        // published" and to getSnapshotAge() as "infinitely stale".
        const db   = faultingDb();
        let   snap = null;
        try { snap = await db.getOracleDataForVM(500, 1700000000, 1800); } catch (e) { /* expected */ }
        assert.strictEqual(snap, null,
            'a fault must never yield {prices:{}, snapshotAge:MAX_SAFE_INTEGER} as if it were data');
    });

    // One case per read in the preload, each faulting alone. The round-window and
    // round-row reads only run once the reads above them answer, which is why the
    // fake resolves everything the pattern does not name.
    const PRELOAD_READS = [
        ['the snapshot-age read',  /MAX\(reference_block\)/i],
        ['the latest-price read',  /INNER JOIN/i],
        ['the round-window read',  /SELECT DISTINCT round_number/i],
        ['the round-row read',     /round_number >= \?/]
    ];
    for (const [label, pattern] of PRELOAD_READS) {
        it('rejects when ' + label + ' alone faults', async function () {
            const db  = dbFaultingOnly(pattern);
            const err = await rejects(() => db.getOracleDataForVM(500, 1700000000, 1800));
            assert.ok(db._seen.some(s => pattern.test(String(s))),
                'the case is inert unless the preload actually issued ' + label);
            assert.ok(err, label + ' must not be allowed to swallow its fault');
            assert.strictEqual(err.errno, 1205);
        });
    }

    it('getOraclePrice rejects rather than reporting no effective oracle price', async function () {
        const db  = faultingDb();
        const err = await rejects(() => db.getOraclePrice('addr', 'BTC', 'TICK', 'USD', 1700000000));
        assert.ok(err, 'a failed read must not become a null price row');
        assert.strictEqual(err.errno, 1205);
    });

    it('getOraclePricesInTimeRange rejects rather than reporting an empty window', async function () {
        const db  = faultingDb();
        const err = await rejects(() =>
            db.getOraclePricesInTimeRange('addr', 'BTC', 'TICK', 'USD', 1699000000, 1700000000));
        assert.ok(err, 'a failed read must not become an empty settlement window');
        assert.strictEqual(err.errno, 1205);
    });

    it('getPricesInTimeRange rejects rather than reporting no validator price', async function () {
        const db  = faultingDb();
        const err = await rejects(() => db.getPricesInTimeRange('BTC/USD', 1699000000, 1700000000));
        assert.ok(err, 'a failed read must not become "no validator price to value the oracle fee"');
        assert.strictEqual(err.errno, 1205);
    });

    it('releases the pooled connection on the way out, as the permissive helper did', async function () {
        // A throwing read that leaked its connection would wedge the pool after a
        // handful of faults, which is a worse failure than the one being fixed.
        const db = faultingDb();
        await rejects(() => db.getPricesInTimeRange('BTC/USD', 1699000000, 1700000000));
        assert.strictEqual(db._released.count, 1, 'the connection must be released even on the throw path');
    });

    it('leaves the local-table cross-chain preload on the permissive helper', async function () {
        // getCrossChainDataForVM reads cross_chain_settlements/xcalls on the LOCAL
        // instance, inside the block transaction, where doQuery already rethrows.
        // Converting it would be scope the fault class does not reach, so this pins
        // that it was deliberately left alone.
        const src = require('fs').readFileSync(require.resolve('../../src/db.js'), 'utf8');
        const fn  = src.slice(src.indexOf('async getCrossChainDataForVM('));
        const end = fn.indexOf('\n    async ', 1);
        assert.ok(/this\.doQuery\(/.test(end === -1 ? fn : fn.slice(0, end)),
            'getCrossChainDataForVM stays on doQuery: it is a local, in-transaction read');
    });

});
