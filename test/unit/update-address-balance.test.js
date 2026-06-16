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

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const Database             = require('../../src/db.js');
const { createMockIndexer } = require('../fixtures/mocks');

// ---------------------------------------------------------------------------
// Helper: create a Database instance with all IO stubbed out
// ---------------------------------------------------------------------------
function makeDb() {
    const indexer = createMockIndexer();
    const db = new Database('localhost', 3306, 'testdb', 'user', 'pass', indexer);
    // Prevent real pool usage
    db.pool                  = { getConnection: sinon.stub().rejects(new Error('no real DB in unit tests')) };
    db.transactionConnection = null;
    // Stub the methods that hit the DB
    db.createAddress           = sinon.stub().resolves(1);
    db.getAddressBalances      = sinon.stub().resolves({});
    db.getAddressTableBalances = sinon.stub().resolves({});
    db.doQuery                 = sinon.stub().resolves([]);
    return db;
}

// ---------------------------------------------------------------------------
// Suite: updateAddressBalance – UPSERT optimization
// ---------------------------------------------------------------------------

describe('Database.updateAddressBalance @unit @regression', function () {

    it('issues UPSERT (not SELECT + INSERT/UPDATE) for a non-zero balance', async function () {
        const db = makeDb();
        db.getAddressBalances.resolves({ 10: '100.000000000000000000' });

        await db.updateAddressBalance('addr1', false);

        const queries = db.doQuery.args.map(a => a[0]);
        assert.ok(
            !queries.some(q => /SELECT\s+id\s+FROM\s+balances/i.test(q)),
            'should not issue a SELECT probe'
        );
        assert.ok(
            queries.some(q => /ON DUPLICATE KEY UPDATE/i.test(q)),
            'should issue UPSERT for non-zero balance'
        );
        assert.ok(
            !queries.some(q => /^UPDATE\s+balances/i.test(q)),
            'should not issue bare UPDATE'
        );
    });

    it('passes correct UPSERT args: (tick_id, address_id, amount)', async function () {
        const db = makeDb();
        db.createAddress.resolves(42);
        db.getAddressBalances.resolves({ 7: '50.000000000000000000' });

        await db.updateAddressBalance('addr1', false);

        const upsertCall = db.doQuery.args.find(a => /ON DUPLICATE KEY UPDATE/i.test(a[0]));
        assert.ok(upsertCall, 'UPSERT call must exist');
        const [, args] = upsertCall;
        // Object keys in JS are always strings, so tick_id arrives as '7'
        assert.strictEqual(String(args[0]), '7', 'first arg should be tick_id');
        assert.strictEqual(args[1], 42,           'second arg should be address_id');
        assert.strictEqual(args[2], '50.000000000000000000', 'third arg should be amount string');
    });

    it('issues DELETE (not UPSERT) for a zero balance', async function () {
        const db = makeDb();
        db.getAddressBalances.resolves({ 10: 0 });

        await db.updateAddressBalance('addr1', false);

        const queries = db.doQuery.args.map(a => a[0]);
        assert.ok(
            !queries.some(q => /ON DUPLICATE KEY UPDATE/i.test(q)),
            'should not issue UPSERT for zero balance'
        );
        assert.ok(
            queries.some(q => /DELETE FROM balances/i.test(q)),
            'should DELETE for zero balance'
        );
    });

    it('multi-token: issues one DML per tick_id, no SELECT probes', async function () {
        const db = makeDb();
        db.getAddressBalances.resolves({
            1: '100.000000000000000000',
            2: '0',
            3: '250.000000000000000000',
        });

        await db.updateAddressBalance('addr1', false);

        const queries = db.doQuery.args.map(a => a[0]);
        assert.strictEqual(db.doQuery.callCount, 3, 'exactly one DML per tick_id');
        assert.ok(!queries.some(q => /SELECT/i.test(q)), 'no SELECT probes');
        const upserts = queries.filter(q => /ON DUPLICATE KEY UPDATE/i.test(q));
        const deletes  = queries.filter(q => /DELETE FROM balances/i.test(q));
        assert.strictEqual(upserts.length, 2, 'two UPSERTs for tick 1 and 3');
        assert.strictEqual(deletes.length,  1, 'one DELETE for tick 2');
    });

    it('rollback: deletes old_balances entries absent from recomputed balances', async function () {
        const db = makeDb();
        // tick 10 is in recomputed balances with a positive balance — rollback should leave it alone
        // tick 11 has no entry at all in recomputed balances — rollback should delete it
        db.getAddressBalances.resolves({ 10: '100.000000000000000000' });
        db.getAddressTableBalances.resolves({ 10: '80', 11: '75' });

        await db.updateAddressBalance('addr1', true);

        const deleteCalls = db.doQuery.args.filter(a => /DELETE FROM balances/i.test(a[0]));
        // Only tick 11 should be deleted (orphaned rollback entry)
        assert.strictEqual(deleteCalls.length, 1,
            'should issue exactly one DELETE for the orphaned rollback tick');
        const deletedTickIds = deleteCalls.map(a => String(a[1][1]));
        assert.ok(deletedTickIds.includes('11'), 'tick 11 deleted via rollback orphan path');
    });

    it('rollback: does NOT delete old_balances entries that still have a non-zero balance', async function () {
        const db = makeDb();
        db.getAddressBalances.resolves({ 10: '100.000000000000000000' });
        db.getAddressTableBalances.resolves({ 10: '80' });

        await db.updateAddressBalance('addr1', true);

        const deleteCalls = db.doQuery.args.filter(a => /DELETE FROM balances/i.test(a[0]));
        assert.strictEqual(deleteCalls.length, 0, 'no DELETE when new balance is non-zero');
    });
});

// ---------------------------------------------------------------------------
// Suite: updateBalances – parallel outer loop
// ---------------------------------------------------------------------------

describe('Database.updateBalances (parallelized) @unit @regression', function () {

    it('calls updateAddressBalance for each address in the array', async function () {
        const db = makeDb();
        db.updateAddressBalance = sinon.stub().resolves();

        await db.updateBalances(['addr1', 'addr2', 'addr3'], false);

        assert.strictEqual(db.updateAddressBalance.callCount, 3);
    });

    it('passes the rollback flag through to each updateAddressBalance call', async function () {
        const db = makeDb();
        db.updateAddressBalance = sinon.stub().resolves();

        await db.updateBalances(['addr1', 'addr2'], true);

        db.updateAddressBalance.args.forEach(([, rollback]) => {
            assert.strictEqual(rollback, true, 'rollback flag should be true');
        });
    });

    it('filters null and empty-string addresses', async function () {
        const db = makeDb();
        db.updateAddressBalance = sinon.stub().resolves();

        await db.updateBalances(['addr1', null, '', 'addr2'], false);

        assert.strictEqual(db.updateAddressBalance.callCount, 2);
    });

    it('handles a single string address', async function () {
        const db = makeDb();
        db.updateAddressBalance = sinon.stub().resolves();

        await db.updateBalances('addr1', false);

        assert.strictEqual(db.updateAddressBalance.callCount, 1);
        assert.ok(db.updateAddressBalance.calledWith('addr1', false));
    });

    it('runs address updates sequentially (one fully completes before the next starts)', async function () {
        // updateBalances intentionally serializes per-address updates: the shared
        // MariaDB connection cannot serve concurrent queries, and a Promise.all
        // here interleaves them and corrupts balances. See src/db.js updateBalances
        // (commit "Fix balance corruption: serialize per-address balance updates").
        const db = makeDb();
        const order = [];
        db.updateAddressBalance = sinon.stub().callsFake(async (addr) => {
            order.push(addr + ':start');
            await new Promise(r => setImmediate(r));
            order.push(addr + ':end');
        });

        await db.updateBalances(['a', 'b', 'c'], false);

        // Serial execution → each address fully completes (start then end) before
        // the next one starts. No interleaving.
        assert.deepStrictEqual(order, [
            'a:start', 'a:end',
            'b:start', 'b:end',
            'c:start', 'c:end',
        ], 'each address must finish before the next begins (no concurrency)');
    });
});
