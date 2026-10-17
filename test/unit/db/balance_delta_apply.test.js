/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/db/balance_delta_apply.test.js
 *
 * Balance projection can retain the historical re-sum, compare it with the
 * per-block delta, or apply that delta directly.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { makeDb } = require('./db_queries.test/helpers/db_stub');
const { getLogger } = require('../../../src/observability/index.js');

afterEach(function () {
    sinon.restore();
});

function balanceDb(mode, stored, summed, delta){
    const db = makeDb();
    db.config['BALANCE_DELTA_MODE'] = mode;
    db._balanceDelta = new Map();
    if(delta)
        db._balanceDelta.set(22, new Map(delta));
    sinon.stub(db, 'getAddressTableBalances').resolves(stored || {});
    sinon.stub(db, 'getAddressBalances').resolves(summed || {});
    sinon.stub(db, 'doQuery').resolves([]);
    return db;
}

function upsertAmount(db){
    const call = db.doQuery.args.find(args => /ON DUPLICATE KEY UPDATE/.test(args[0]));
    return call && call[1][2];
}

describe('balance delta application modes @regression @tier1', function () {
    it('off re-sums ledger history and leaves the collected delta available', async function () {
        const db = balanceDb('off', { 11: '10' }, { 11: '14' }, [[11, '3']]);

        await db.updateAddressBalance(22, false);

        assert.ok(db.getAddressBalances.calledOnceWithExactly(22));
        assert.strictEqual(db.getAddressTableBalances.callCount, 0);
        assert.strictEqual(upsertAmount(db), '14');
        assert.ok(db._balanceDelta.has(22));
    });

    it('on applies the pending delta without reading ledger history', async function () {
        const db = balanceDb('on', { 11: '10' }, { 11: '999' }, [[11, '2.5']]);

        await db.updateAddressBalance(22, false);

        assert.ok(db.getAddressTableBalances.calledOnceWithExactly(22));
        assert.strictEqual(db.getAddressBalances.callCount, 0);
        assert.strictEqual(upsertAmount(db), '12.5');
        assert.ok(!db._balanceDelta.has(22));
    });

    it('on inserts a new dust balance in normal notation', async function () {
        const db = balanceDb('on', {}, {}, [[11, '3e-8']]);

        await db.updateAddressBalance(22, false);

        assert.strictEqual(upsertAmount(db), '0.00000003');
    });

    it('on deletes a balance driven exactly to zero', async function () {
        const db = balanceDb('on', { 11: '10' }, {}, [[11, '-10']]);

        await db.updateAddressBalance(22, false);

        assert.ok(db.doQuery.calledOnce);
        assert.match(db.doQuery.firstCall.args[0], /DELETE FROM balances/);
        assert.deepStrictEqual(db.doQuery.firstCall.args[1], [22, '11']);
    });

    it('verify persists the re-sum and stays quiet when the delta agrees', async function () {
        const warn = sinon.stub(getLogger(), 'warn');
        const db = balanceDb('verify', { 11: '10' }, { 11: '12.5' }, [[11, '2.5']]);

        await db.updateAddressBalance(22, false);

        assert.ok(db.getAddressTableBalances.calledOnce);
        assert.ok(db.getAddressBalances.calledOnce);
        assert.strictEqual(upsertAmount(db), '12.5');
        assert.strictEqual(warn.callCount, 0);
        assert.ok(!db._balanceDelta.has(22));
    });

    it('verify logs each mismatch but still persists the re-summed balance', async function () {
        const warn = sinon.stub(getLogger(), 'warn');
        const db = balanceDb('verify', { 11: '10' }, { 11: '14' }, [[11, '3']]);

        await db.updateAddressBalance(22, false);

        assert.strictEqual(upsertAmount(db), '14');
        assert.ok(warn.calledOnce);
        assert.match(warn.firstCall.args[0], /address_id=22 tick_id=11 delta=13 summed=14/);
    });

    it('rollback re-sums even when delta application is on', async function () {
        const db = balanceDb('on', { 11: '10', 12: '8' }, { 11: '7' }, [[11, '99']]);

        await db.updateAddressBalance(22, true);

        assert.ok(db.getAddressBalances.calledOnceWithExactly(22));
        assert.strictEqual(upsertAmount(db), '7');
        const deletes = db.doQuery.args.filter(args => /DELETE FROM balances/.test(args[0]));
        assert.strictEqual(deletes.length, 1);
        assert.deepStrictEqual(deletes[0][1], [22, '12']);
        assert.ok(db._balanceDelta.has(22));
    });

    it('preserves a delta when its balance write fails', async function () {
        const db = balanceDb('on', { 11: '10' }, {}, [[11, '2']]);
        db.doQuery.rejects(new Error('write failed'));

        await assert.rejects(() => db.updateAddressBalance(22, false), /write failed/);

        assert.ok(db._balanceDelta.has(22));
    });

    it('falls back to a re-sum when no block delta collector is active', async function () {
        const db = balanceDb('on', {}, { 11: '6' }, null);
        db._balanceDelta = null;

        await db.updateAddressBalance(22, false);

        assert.ok(db.getAddressBalances.calledOnceWithExactly(22));
        assert.strictEqual(db.getAddressTableBalances.callCount, 0);
        assert.strictEqual(upsertAmount(db), '6');
    });
});
